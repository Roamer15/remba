// src/whatsapp/message-handler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';
import { OpenaiService } from 'src/openai/openai.service';
import { WhatsappService } from './whatsapp.service';
import { AnalyticsService } from '../scheduler/analytics.service';
import { IncomingMessagePayload } from './interfaces/onboarding-result.interface';
import type { User } from 'src/generated/prisma/client';

@Injectable()
export class MessageHandlerService {
  private readonly logger = new Logger(MessageHandlerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openaiService: OpenaiService,
    private readonly whatsappService: WhatsappService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /**
   * Main entry point for all incoming message streams routing through your webhook
   */
  async handleIncomingPayload(payload: IncomingMessagePayload): Promise<void> {
    const { from, text, profileName } = payload;
    // 1. Check if user already exists in the database
    const user = await this.prisma.user.findUnique({
      where: { phoneNumber: from },
    });
    if (!user) {
      this.logger.log(
        `New user detected from number: ${from}. Running onboarding engine...`,
      );

      // 2. Execute Day 2 AI logic
      const onboardingData = await this.openaiService.processNewUserOnboarding(
        text,
        profileName,
      );

      // 3. Persist user using upsert to prevent race condition
      // If another request already created the user, this will just retrieve it
      await this.prisma.user.upsert({
        where: { phoneNumber: from },
        create: {
          phoneNumber: from,
          name: onboardingData.cleanedName,
          language: onboardingData.detectedLanguage,
        },
        update: {}, // Don't update if already exists
      });

      // 4. Send back the warm welcome text through Meta Cloud API
      // Wrap in try-catch to prevent failed messages from breaking the flow
      try {
        await this.whatsappService.sendWhatsAppPayload(
          from,
          onboardingData.greetingResponse,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send greeting to ${from}, but user was successfully created`,
          error instanceof Error ? error : new Error(String(error)),
        );
        // Don't re-throw - user is created, greeting delivery is best-effort
      }
      return;
    }

    this.logger.log(
      `Interaction received from existing user: ${user.name || from}`,
    );

    const upperText = text.trim().toUpperCase();

    // Keyword Demand for Health Analytics
    if (upperText === 'REPORT' || upperText === 'BILAN') {
      this.logger.log(
        `User ${from} requested on-demand metrics. Routing to AnalyticsService...`,
      );
      await this.analyticsService.processAndSendWeeklyReport(from);
      return;
    }

    // If they are replying to a medication alarm check-in
    if (upperText === 'TAKEN' || upperText.startsWith('SKIP')) {
      this.logger.log(`Routing ${from} to Day 5 Adherence Engine...`);
      await this.processAdherenceCheckIn(user, text);
      return;
    }

    // Default to assuming they are attempting to add a new medication schedule
    this.logger.log(`Routing ${from} to Day 3 Medication Extraction Engine...`);
    await this.processExistingUserConversation(user, text);
  }

  /**
   * Processes incoming interaction strings for users already registered in our database.
   */
  private async processExistingUserConversation(
    user: User,
    text: string,
  ): Promise<void> {
    const language = (user.language as 'EN' | 'FR') || 'EN';

    // Invoke the OpenAI parsing script
    const extraction = await this.openaiService.extractMedicationSchedules(
      text,
      language,
      user.name || 'Friend',
    );

    // Guardrail Catch: If no medication reminders were detected (conversational inputs)
    if (extraction.remindersFound.length === 0) {
      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        extraction.confirmationMessage,
      );
      return;
    }

    const existingReminders = await this.prisma.reminder.findMany({
      where: { userPhoneNumber: user.phoneNumber },
    });

    const duplicateReminders: typeof extraction.remindersFound = [];
    const validRemindersToCreate: typeof extraction.remindersFound = [];

    for (const extracted of extraction.remindersFound) {
      const isDuplicate = existingReminders.some(
        (existing) =>
          existing.medicationName.toLowerCase() ===
            extracted.medicationName.toLowerCase() &&
          existing.reminderTime === extracted.reminderTime,
      );

      if (isDuplicate) {
        duplicateReminders.push(extracted);
      } else {
        validRemindersToCreate.push(extracted);
      }
    }

    if (validRemindersToCreate.length === 0) {
      const allDuplicateWarning =
        language === 'FR'
          ? `Désolé ${user.name}, vous avez déjà configuré un rappel pour ce médicament à cette heure exacte.`
          : `Sorry ${user.name}, you have already configured a reminder for this medication at this exact time.`;

      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        allDuplicateWarning,
      );
      return;
    }

    // Persistent Relational Save Loop via Prisma Client
    try {
      // We map the array records into a structured transaction block
      await this.prisma.user.update({
        where: { phoneNumber: user.phoneNumber },
        data: {
          reminders: {
            create: extraction.remindersFound.map((rem) => ({
              medicationName: rem.medicationName,
              reminderTime: rem.reminderTime,
            })),
          },
        },
      });

      this.logger.log(
        `Successfully linked ${extraction.remindersFound.length} medication items to phone profile: ${user.phoneNumber}`,
      );

      // Send back the clean conversational confirmation text generated by OpenAI
      let finalMessage = extraction.confirmationMessage;
      if (duplicateReminders.length > 0) {
        const partialWarning =
          language === 'FR'
            ? `\n\n(Note: Certains rappels en double n'ont pas été recréés).`
            : `\n\n(Note: Some duplicate reminders were skipped as they already exist).`;
        finalMessage += partialWarning;
      }

      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        finalMessage,
      );
    } catch (error) {
      this.logger.error(
        `Prisma relation transaction failed for ${user.phoneNumber}`,
        error instanceof Error ? error : new Error(String(error)),
      );

      // Graceful error response handling fallback as specified in your interview design parameters
      const systemErrorMessage =
        language === 'FR'
          ? "Oups, un problème technique est survenu. Veuillez réessayer d'enregistrer votre médicament."
          : 'Oops, something went wrong on our side. Please try registering your medication details again.';

      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        systemErrorMessage,
      );
    }
  }

  // src/modules/whatsapp/message-handler.service.ts

  private async processAdherenceCheckIn(
    user: User,
    text: string,
  ): Promise<void> {
    const language = (user.language as 'EN' | 'FR') || 'EN';
    const cleanInput = text.trim().toUpperCase();

    // 1. Process intent classification using our Day 5 OpenAI engine
    const analysis = await this.openaiService.parseAdherenceResponse(
      cleanInput,
      language,
      user.name || 'Friend',
    );

    // If it's unrelated conversation, let the AI's default motivational response handle the feedback loop
    if (analysis.intent === 'UNKNOWN') {
      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        analysis.motivationalResponse,
      );
      return;
    }

    // 2. Query Prisma for the most recent PENDING dose log entry for this phone number
    const latestPendingLog = await this.prisma.doseLog.findFirst({
      where: {
        status: 'PENDING',
        reminder: {
          userPhoneNumber: user.phoneNumber,
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      include: {
        reminder: true,
      },
    });

    // Guard check: If they reply TAKEN but no alert was active, tell them gently
    if (!latestPendingLog) {
      const nonPendingMessage =
        language === 'FR'
          ? `Bonjour ${user.name}, vous n'avez aucun rappel en attente pour le moment. Merci de rester vigilant !`
          : `Hi ${user.name}, you don't have any pending medication reminders active right now. Keep up the great health management!`;

      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        nonPendingMessage,
      );
      return;
    }

    // 3. Time Precedence Calculations (Your Fixed Blueprint)
    const alertTime = new Date(latestPendingLog.timestamp).getTime();
    const replyTime = new Date().getTime();
    const diffInMinutes = Math.floor((replyTime - alertTime) / (1000 * 60));

    let finalStatus: 'TAKEN' | 'TAKEN_LATE' | 'SKIPPED' = 'TAKEN';

    if (analysis.intent === 'TAKEN') {
      if (diffInMinutes > 60 && diffInMinutes <= 240) {
        finalStatus = 'TAKEN_LATE';
      } else if (diffInMinutes > 240) {
        // If they reply TAKEN but it's been more than 4 hours, it's clinically considered SKIPPED/Missed
        finalStatus = 'SKIPPED';
      }
    } else if (analysis.intent === 'SKIP') {
      finalStatus = 'SKIPPED';
    }

    // 4. Update Database Log and Streaks cleanly using Prisma Transaction Blocks
    try {
      await this.prisma.$transaction(async (tx) => {
        // Update the state logs status and notes column field
        await tx.doseLog.update({
          where: { id: latestPendingLog.id },
          data: {
            status: finalStatus,
            notes: analysis.skipReasonNotes || null,
          },
        });

        // Manage Streak Counters dynamically based on compliance rules
        if (finalStatus === 'TAKEN') {
          await tx.reminder.update({
            where: { id: latestPendingLog.reminderId },
            data: { streakCount: { increment: 1 } },
          });
        } else if (finalStatus === 'SKIPPED') {
          // Reset streak calculation safely on missed parameters
          await tx.reminder.update({
            where: { id: latestPendingLog.reminderId },
            data: { streakCount: 0 },
          });
        }
      });

      // 5. Send back OpenAI's contextual motivational validation payload feedback text
      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        analysis.motivationalResponse,
      );
    } catch (error) {
      this.logger.error(
        `Failed to execute compliance database resolve transaction for ${user.phoneNumber}`,
        error,
      );
    }
  }
}
