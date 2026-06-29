import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';
import { OpenaiService } from 'src/openai/openai.service';
import { WhatsappService } from './whatsapp.service';
import { AgentService } from '../agent/agent.service';
import { IncomingMessagePayload } from './interfaces/onboarding-result.interface';
import type { User } from 'src/generated/prisma/client';

@Injectable()
export class MessageHandlerService {
  private readonly logger = new Logger(MessageHandlerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openaiService: OpenaiService,
    private readonly whatsappService: WhatsappService,
    private readonly agentService: AgentService,
  ) {}

  /**
   * Main entry point for all incoming message streams routing through the webhook.
   * New users are onboarded; existing users are handed to the tool-using agent.
   */
  async handleIncomingPayload(payload: IncomingMessagePayload): Promise<void> {
    const { from, profileName, imageId, audioId } = payload;
    let { text } = payload;

    const user = await this.prisma.user.findUnique({
      where: { phoneNumber: from },
    });

    // Voice note: transcribe it to text, then continue exactly as if typed.
    if (audioId) {
      const transcript = await this.transcribeVoiceNote(from, audioId, user);
      if (transcript === null) return; // user was already notified of failure
      text = transcript;
    }

    if (!user) {
      await this.onboardNewUser(from, text, profileName);
      return;
    }

    // If an image (e.g. a prescription photo) was attached, fetch it so the
    // agent's vision step can read it. Fall back to text-only on failure.
    let imageDataUrl: string | undefined;
    if (imageId) {
      try {
        imageDataUrl = await this.whatsappService.fetchMediaAsDataUrl(imageId);
        this.logger.log(`Fetched image media ${imageId} for ${from}.`);
      } catch (error) {
        this.logger.error(
          `Failed to fetch image media ${imageId} for ${from}; proceeding text-only.`,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    this.logger.log(
      `Routing interaction from ${user.name || from} to the agent engine.`,
    );
    await this.agentService.run(user, text, imageDataUrl);
  }

  /**
   * Fetches a voice note and transcribes it to text. Returns null (after
   * notifying the patient) when transcription fails, so the caller can stop.
   */
  private async transcribeVoiceNote(
    from: string,
    audioId: string,
    user: User | null,
  ): Promise<string | null> {
    try {
      const { data, mimeType } =
        await this.whatsappService.fetchMediaBytes(audioId);
      const transcript = await this.openaiService.transcribeAudio(
        data,
        mimeType,
        user?.language,
      );
      this.logger.log(`Transcribed voice note from ${from}: "${transcript}"`);
      return transcript;
    } catch (error) {
      this.logger.error(
        `Failed to transcribe voice note from ${from}`,
        error instanceof Error ? error : new Error(String(error)),
      );

      const language = (user?.language as 'EN' | 'FR') || 'EN';
      await this.whatsappService.sendWhatsAppPayload(
        from,
        language === 'FR'
          ? "Désolé, je n'ai pas pu comprendre votre note vocale. Pouvez-vous réessayer ou écrire votre message ?"
          : "Sorry, I couldn't understand your voice note. Could you try again, or type your message?",
      );
      return null;
    }
  }

  /**
   * Handles first contact: detect language, clean the profile name, create the
   * user record, and send a localized greeting.
   */
  private async onboardNewUser(
    from: string,
    text: string,
    profileName: string,
  ): Promise<void> {
    this.logger.log(
      `New user detected from number: ${from}. Running onboarding engine...`,
    );

    const onboardingData = await this.openaiService.processNewUserOnboarding(
      text,
      profileName,
    );

    await this.prisma.user.upsert({
      where: { phoneNumber: from },
      create: {
        phoneNumber: from,
        name: onboardingData.cleanedName,
        language: onboardingData.detectedLanguage,
      },
      update: {},
    });

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
    }
  }
}
