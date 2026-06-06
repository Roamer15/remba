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
    const user = await this.prisma.user.findUnique({
      where: { phoneNumber: from },
    });
    if (!user) {
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
      return;
    }

    this.logger.log(
      `Interaction received from existing user: ${user.name || from}`,
    );

    const upperText = text.trim().toUpperCase();

    if (upperText === 'HELP' || upperText === 'MENU' || upperText === 'AIDE') {
      this.logger.log(`User ${from} requested the command directory matrix.`);

      const isFrench = user.language === 'FR';
      const directoryMessage = isFrench
        ? `📋 *GUIDE DES COMMANDES REMBA* 📋\n\n` +
          `Voici comment interagir avec moi :\n\n` +
          `• *TAKEN* : Confirmez que vous avez pris votre dose actuelle.\n` +
          `• *SKIP* : Indiquez une omission (ex: "SKIP j'ai oublié").\n` +
          `• *BILAN* ou *REPORT* : Recevez votre rapport de santé hebdomadaire.\n` +
          `• *AIDE* ou *MENU* : Réaffichez ce guide.\n\n` +
          `👥 *AJOUTER UN ENCADRANT / GARDE MALADE :*\n` +
          `Écrivez : *MENTOR [Nom] [Numéro]*\n` +
          `_(Exemple : MENTOR JohnDoe 2376XXXXXXXXX)_\n\n` +
          `*AJOUTER UN MÉDICAMENT :*\n` +
          `Écrivez simplement vos détails naturellement (ex: "Prendre Paracétamol à 8h et 20h").`
        : `*REMBA COMMAND DIRECTORY*\n\n` +
          `Here are the keywords you can use to interact with me:\n\n` +
          `• *TAKEN* : Confirm you have successfully taken your current dose.\n` +
          `• *SKIP* : Log a missed dose along with your reason (e.g., "SKIP ran out of stock").\n` +
          `• *REPORT* or *BILAN* : Instantly pull down your 7-day health performance report.\n` +
          `• *HELP* or *MENU* : Pull up this command directory guide.\n\n` +
          `*TO ADD A HEALTH MENTOR / SUPPORTER / CARETAKER(We'll reach out to them if you don't take your medication properly) :*\n` +
          `Type: *MENTOR [Name] [PhoneNumber]*\n` +
          `_(Example: MENTOR JohnDoe 2376XXXXXXXXX)_\n\n` +
          `*REGISTER A NEW MEDICATION :*\n` +
          `Type your instructions naturally (e.g., "I need to take Amoxicillin at 8am and 8pm").`;
      await this.whatsappService.sendWhatsAppPayload(from, directoryMessage);
      return;
    }

    if (upperText.startsWith('MENTOR')) {
      this.logger.log(
        `User ${from} is attempting a mentor relationship mapping linking operation...`,
      );

      const isFrench = user.language === 'FR';

      const messageParts = text.trim().split(/\s+/);

      if (messageParts.length < 3) {
        const formattingErrorMessage = isFrench
          ? `*Format Invalide !*\nVeuillez utiliser le format exact suivant :\n*MENTOR [Nom] [Numéro]*\n_(Ex: MENTOR JohnDoe 2376XXXXXXXXX)`
          : `*Invalid Format !*\nPlease use this exact structural layout format:\n*MENTOR [Name] [PhoneNumber]*\n_(e.g., MENTOR JohnDoe 2376XXXXXXXXX)`;

        await this.whatsappService.sendWhatsAppPayload(
          from,
          formattingErrorMessage,
        );
        return;
      }

      const extractedMentorName = messageParts[1];
      const extractedMentorPhone = messageParts[2];

      try {
        await this.prisma.$transaction(async (tx) => {
          const mentorRecord = await tx.mentor.upsert({
            where: { phoneNumber: extractedMentorPhone },
            create: {
              name: extractedMentorName,
              phoneNumber: extractedMentorPhone,
            },
            update: {
              name: extractedMentorName,
            },
          });

          await tx.user.update({
            where: { phoneNumber: from },
            data: {
              mentorId: mentorRecord.id,
            },
          });
        });

        const successLinkMessage = isFrench
          ? ` *Mentor Enregistré !*\n${extractedMentorName} (${extractedMentorPhone}) est maintenant configuré comme votre encadrant de traitement. En cas d'oublis de doses répétés, il recevra une alerte de sécurité.`
          : ` *Mentor Linked Successfully !*\n${extractedMentorName} (${extractedMentorPhone}) has been assigned as your treatment supporter. If you miss multiple consecutive doses, they will be sent a safety S.O.S alert automatically.`;

        await this.whatsappService.sendWhatsAppPayload(
          from,
          successLinkMessage,
        );
        this.logger.log(
          `Successfully mapped patient ${from} to treatment mentor profile ${extractedMentorPhone}`,
        );
      } catch (mentorError) {
        this.logger.error(
          `Failed to handle transactional mentor link mapping for user ${from}`,
          mentorError,
        );

        const systemErrorFallback = isFrench
          ? `Oups, impossible d'enregistrer l'encadrant pour le moment. Veuillez réessayer.`
          : `Oops, something went wrong on our side and we couldn't save your mentor. Please try again.`;

        await this.whatsappService.sendWhatsAppPayload(
          from,
          systemErrorFallback,
        );
      }
      return;
    }

    if (upperText === 'REPORT' || upperText === 'BILAN') {
      this.logger.log(
        `User ${from} requested on-demand metrics. Routing to AnalyticsService...`,
      );
      await this.analyticsService.processAndSendWeeklyReport(from);
      return;
    }

    if (upperText === 'TAKEN' || upperText.startsWith('SKIP')) {
      this.logger.log(`Routing ${from} to Adherence Engine...`);
      await this.processAdherenceCheckIn(user, text);
      return;
    }
    this.logger.log(
      `Analyzing conversational intent for user: ${user.name || from}`,
    );
    const userLanguage = (user.language as 'EN' | 'FR') || 'EN';

    const classification =
      await this.openaiService.classifyAndHandleConversation(
        text,
        user.name || 'Friend',
        userLanguage,
      );

    if (classification.type === 'CHAT') {
      this.logger.log(
        `User interaction categorized as casual conversation. Dispatching care response.`,
      );
      await this.whatsappService.sendWhatsAppPayload(
        from,
        classification.responseText ??
          'Sorry, I could not generate a response right now. Please try again.',
      );
      return;
    }

    this.logger.log(`Routing ${from} to Medication Extraction Engine...`);
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

    const extraction = await this.openaiService.extractMedicationSchedules(
      text,
      language,
      user.name || 'Friend',
    );

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

    try {
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

  private async processAdherenceCheckIn(
    user: User,
    text: string,
  ): Promise<void> {
    const language = (user.language as 'EN' | 'FR') || 'EN';
    const cleanInput = text.trim().toUpperCase();

    const analysis = await this.openaiService.parseAdherenceResponse(
      cleanInput,
      language,
      user.name || 'Friend',
    );

    if (analysis.intent === 'UNKNOWN') {
      await this.whatsappService.sendWhatsAppPayload(
        user.phoneNumber,
        analysis.motivationalResponse,
      );
      return;
    }

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

    const alertTime = new Date(latestPendingLog.timestamp).getTime();
    const replyTime = new Date().getTime();
    const diffInMinutes = Math.floor((replyTime - alertTime) / (1000 * 60));

    let finalStatus: 'TAKEN' | 'TAKEN_LATE' | 'SKIPPED' = 'TAKEN';

    if (analysis.intent === 'TAKEN') {
      if (diffInMinutes > 60 && diffInMinutes <= 240) {
        finalStatus = 'TAKEN_LATE';
      } else if (diffInMinutes > 240) {
        finalStatus = 'SKIPPED';
      }
    } else if (analysis.intent === 'SKIP') {
      finalStatus = 'SKIPPED';
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.doseLog.update({
          where: { id: latestPendingLog.id },
          data: {
            status: finalStatus,
            notes: analysis.skipReasonNotes || null,
          },
        });

        if (finalStatus === 'TAKEN') {
          await tx.reminder.update({
            where: { id: latestPendingLog.reminderId },
            data: { streakCount: { increment: 1 } },
          });
        } else if (finalStatus === 'SKIPPED') {
          await tx.reminder.update({
            where: { id: latestPendingLog.reminderId },
            data: { streakCount: 0 },
          });
        }
      });

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
