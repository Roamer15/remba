// src/modules/agent/agent.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type {
  ChatCompletionMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources.js';
import type { User } from 'src/generated/prisma/client';
import { PrismaService } from 'src/prisma.service';
import { OpenaiService } from 'src/openai/openai.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { AnalyticsService } from '../scheduler/analytics.service';
import { TOOL_SCHEMAS, buildToolRegistry, ToolHandler } from './tools';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  /** Maximum number of model<->tool round-trips before giving up. */
  private readonly MAX_STEPS = 5;
  /** How many prior messages to load as conversational memory. */
  private readonly HISTORY_LIMIT = 12;

  private readonly registry: Record<string, ToolHandler>;
  /** Per-user promise chain to serialize concurrent inbound messages. */
  private readonly chain = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly openai: OpenaiService,
    private readonly whatsappService: WhatsappService,
    private readonly analytics: AnalyticsService,
  ) {
    this.registry = buildToolRegistry({ prisma, analytics });
  }

  /**
   * Entry point: runs the agent for one inbound message, serialized per user so
   * two quick messages can't race on conversation history. An optional image
   * data URL enables multimodal input (e.g. a prescription photo).
   */
  async run(
    user: User,
    incomingText: string,
    imageDataUrl?: string,
  ): Promise<void> {
    const run = (this.chain.get(user.phoneNumber) ?? Promise.resolve()).then(
      () => this.process(user, incomingText, imageDataUrl),
      () => this.process(user, incomingText, imageDataUrl),
    );
    // Stored link never rejects, so the next message can always chain onto it.
    this.chain.set(
      user.phoneNumber,
      run.catch(() => undefined),
    );
    return run;
  }

  private async process(
    user: User,
    incomingText: string,
    imageDataUrl?: string,
  ): Promise<void> {
    const language = (user.language as 'EN' | 'FR') || 'EN';

    try {
      const history = await this.loadHistory(user);
      const systemPrompt = await this.buildSystemPrompt(user);

      const userMessage: ChatCompletionUserMessageParam = imageDataUrl
        ? {
            role: 'user',
            content: [
              {
                type: 'text',
                text: incomingText || 'Please read this image.',
              },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          }
        : { role: 'user', content: incomingText };

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history,
        userMessage,
      ];

      let finalText: string | null = null;

      for (let step = 0; step < this.MAX_STEPS; step++) {
        const message = await this.openai.runToolCompletion(
          messages,
          TOOL_SCHEMAS,
        );

        const toolCalls = message.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          // Echo the assistant's tool-call message, then append each result.
          messages.push(message as ChatCompletionMessageParam);

          for (const call of toolCalls) {
            if (call.type !== 'function') continue;
            const result = await this.executeTool(
              call.function.name,
              call.function.arguments,
              user,
            );
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
          }
          continue;
        }

        finalText = message.content;
        break;
      }

      if (!finalText) {
        this.logger.warn(
          `Agent produced no final text for ${user.phoneNumber} (max steps or empty content). Using fallback.`,
        );
        finalText = this.fallbackText(language);
      }

      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        finalText,
      );
      await this.persistTurn(user, incomingText, finalText);
    } catch (error) {
      this.logger.error(
        `Agent run failed for ${user.phoneNumber}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      try {
        await this.whatsappService.sendWhatsAppPayload(
          user.phoneNumber,
          this.fallbackText(language),
        );
      } catch {
        // best-effort fallback; swallow secondary send failure
      }
    }
  }

  private async executeTool(
    name: string,
    rawArgs: string,
    user: User,
  ): Promise<Record<string, unknown>> {
    const handler = this.registry[name];
    if (!handler) {
      return { success: false, error: `Unknown tool: ${name}` };
    }

    let args: Record<string, any> = {};
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return { success: false, error: 'Invalid tool arguments JSON.' };
    }

    try {
      const result = await handler(args, user);
      this.logger.log(`Tool '${name}' executed for ${user.phoneNumber}`);
      return result;
    } catch (error) {
      this.logger.error(
        `Tool '${name}' failed for ${user.phoneNumber}`,
        error instanceof Error ? error : new Error(String(error)),
      );
      return { success: false, error: 'Tool execution failed.' };
    }
  }

  private async loadHistory(
    user: User,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const rows = await this.prisma.message.findMany({
      where: { userPhoneNumber: user.phoneNumber },
      orderBy: { createdAt: 'desc' },
      take: this.HISTORY_LIMIT,
    });

    return rows
      .reverse()
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }

  private async persistTurn(
    user: User,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    await this.prisma.message.createMany({
      data: [
        { userPhoneNumber: user.phoneNumber, role: 'user', content: userText },
        {
          userPhoneNumber: user.phoneNumber,
          role: 'assistant',
          content: assistantText,
        },
      ],
    });
  }

  private async buildSystemPrompt(user: User): Promise<string> {
    const reminders = await this.prisma.reminder.findMany({
      where: { userPhoneNumber: user.phoneNumber, isActive: true },
      select: { medicationName: true, reminderTime: true, streakCount: true },
    });

    const offset = user.timezoneOffset ?? 1;
    const now = new Date();
    let localMinutes = now.getUTCHours() * 60 + now.getUTCMinutes() + offset * 60;
    localMinutes = ((localMinutes % 1440) + 1440) % 1440;
    const localClock = `${String(Math.floor(localMinutes / 60)).padStart(2, '0')}:${String(localMinutes % 60).padStart(2, '0')}`;

    const reminderList =
      reminders.length > 0
        ? reminders
            .map(
              (r) =>
                `- ${r.medicationName} at ${r.reminderTime} (streak: ${r.streakCount})`,
            )
            .join('\n')
        : '(none yet)';

    const language = (user.language as 'EN' | 'FR') || 'EN';

    return `You are Remba, a warm, empathetic, professional virtual health companion in Cameroon. You help patients with chronic conditions (HIV, TB, hypertension) stay adherent to their medication.

PATIENT CONTEXT:
- Name: ${user.name || 'Friend'}
- Language: ${language} — you MUST reply entirely in this language (EN = English, FR = French).
- Current local time: ${localClock}
- Active reminders:
${reminderList}

CAPABILITIES (use the provided tools to take real actions — never just claim you did):
- Create reminders, change a reminder's time, cancel a reminder, log a taken/skipped dose, fetch the weekly adherence report, link a treatment mentor, and list current reminders.
- To RESCHEDULE an existing reminder, use update_reminder (NOT create) so you don't make a duplicate. Match it against the active reminders listed above.
- After a tool runs, confirm the outcome to the patient warmly and concisely. If a tool reports a duplicate, a missing reminder, or that there was no pending dose, explain that gently.

SAFETY GUARDRAILS:
- You are NOT a doctor. Never diagnose conditions or prescribe/adjust dosages.
- When giving general health information, keep it brief and add a short reminder to consult their clinic or healthcare provider.
- For any red-flag or emergency symptoms (e.g. chest pain, trouble breathing, severe reactions), urge them to contact their local clinic or their mentor immediately.
- Stay focused on medication adherence and supportive care. Gently redirect off-topic chats back to their treatment.

STYLE:
- Concise and friendly, easy to read on a WhatsApp screen. Short paragraphs; light emojis are fine.`;
  }

  private fallbackText(language: 'EN' | 'FR'): string {
    return language === 'FR'
      ? "Désolé, j'ai rencontré un problème technique. Pouvez-vous réessayer dans un instant ?"
      : 'Sorry, I ran into a technical issue. Could you try again in a moment?';
  }
}
