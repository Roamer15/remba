import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';
import { OpenaiService } from 'src/openai/openai.service';
import { WhatsappService } from './whatsapp.service';
import { AgentService } from '../agent/agent.service';
import { IncomingMessagePayload } from './interfaces/onboarding-result.interface';

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
    const { from, text, profileName, imageId } = payload;

    const user = await this.prisma.user.findUnique({
      where: { phoneNumber: from },
    });

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
