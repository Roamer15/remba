// src/whatsapp/message-handler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';
import { OpenaiService } from 'src/openai/openai.service';
import { WhatsappService } from './whatsapp.service';
import { IncomingMessagePayload } from './interfaces/onboarding-result.interface';
import type { User } from 'src/generated/prisma/client';

@Injectable()
export class MessageHandlerService {
  private readonly logger = new Logger(MessageHandlerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openaiService: OpenaiService,
    private readonly whatsappService: WhatsappService,
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

    // 5. Existing user route (Day 3 & Day 6 Logic)
    this.logger.log(`Recurring user interaction from: ${user.name || from}`);
    await this.processExistingUserConversation(user, text);
  }

  private async processExistingUserConversation(
    user: User,
    text: string,
  ): Promise<void> {
    await this.whatsappService.sendWhatsAppPayload(
      user.phoneNumber || '',
      user.language === 'FR'
        ? `Merci ${user.name}, ${text}`
        : `Thank you ${user.name}, ${text}`,
    );
  }
}
