// src/modules/scheduler/scheduler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { AnalyticsService } from './analytics.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsappService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleMedicationAlerts() {
    const baseServerDate = new Date(); // Get base UTC system clock

    this.logger.log(
      `Cron loop ticking. System UTC Hour: ${baseServerDate.getUTCHours()}:${baseServerDate.getUTCMinutes()}`,
    );

    // Fetch ALL active reminders along with their user settings
    const activeReminders = await this.prisma.reminder.findMany({
      where: { isActive: true },
      include: { user: true },
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    for (const reminder of activeReminders) {
      try {
        // DYNAMIC TIMEZONE MATH: Calculate the precise hour for THIS specific user
        const userOffset = reminder.user.timezoneOffset; // e.g. +1 or -4

        const userLocalDate = new Date(
          baseServerDate.getTime() + userOffset * 60 * 60 * 1000,
        );

        const userHours = String(userLocalDate.getUTCHours()).padStart(2, '0');
        const userMinutes = String(userLocalDate.getUTCMinutes()).padStart(
          2,
          '0',
        );
        const computedUserTime = `${userHours}:${userMinutes}`; // e.g. "08:00"

        // Only fire if the computed local time matches their requested alarm string!
        if (reminder.reminderTime !== computedUserTime) {
          continue;
        }

        // Idempotency check
        const existingLog = await this.prisma.doseLog.findFirst({
          where: {
            reminderId: reminder.id,
            timestamp: { gte: todayStart },
          },
        });

        if (existingLog) continue;

        // Build templates and dispatch
        const isFrench = reminder.user.language === 'FR';
        const userName = reminder.user.name || 'Friend';

        const alertMessage = isFrench
          ? `Bonjour ${userName}, il est ${reminder.reminderTime} et c'est l'heure de prendre votre ${reminder.medicationName}. N'oubliez pas que prendre votre traitement régulièrement est important pour votre santé. Veuillez répondre "TAKEN" lorsque vous aurez pris votre dose pour que je puisse suivre votre progression 😊`
          : `Hi ${userName}, it's ${reminder.reminderTime} and time for you to take your ${reminder.medicationName}. Remember taking your medication is important for your long-term health. Please when done taking your medication respond to me with "TAKEN" so I can track your streak 😊`;
        await this.prisma.doseLog.create({
          data: { reminderId: reminder.id, status: 'PENDING' },
        });

        await this.whatsappService.sendWhatsAppPayload(
          reminder.userPhoneNumber,
          alertMessage,
        );
        this.logger.log(
          `Alert delivered dynamically for localized zone matching time: ${computedUserTime}`,
        );

        // Inside src/modules/scheduler/scheduler.service.ts -> handleMedicationAlerts()

        // Calculate the point in time exactly 5 hours ago
        const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);

        // Find all pending logs that have been left abandoned past this window
        const abandonedLogs = await this.prisma.doseLog.findMany({
          where: {
            status: 'PENDING',
            timestamp: { lt: fiveHoursAgo },
          },
          include: {
            reminder: {
              include: {
                user: true,
              },
            },
          },
        });

        // Automatically sweep abandoned items to SKIPPED status and reset streaks
        for (const log of abandonedLogs) {
          try {
            await this.prisma.$transaction(async (tx) => {
              // 1. Mark the log as skipped
              await tx.doseLog.update({
                where: { id: log.id },
                data: {
                  status: 'SKIPPED',
                  notes: 'Auto-skipped: No user response within 5 hours.',
                },
              });

              // 2. Reset that medication's streak count back to 0
              await tx.reminder.update({
                where: { id: log.reminderId },
                data: { streakCount: 0 },
              });
            });

            this.logger.log(
              `[TIMEOUT ENGINE] Auto-skipped expired log ${log.id} for reminder ${log.reminderId}`,
            );

            const userLanguage =
              (log.reminder.user?.language as 'EN' | 'FR') || 'EN';
            await this.checkAndTriggerEscalation(
              log.reminder.userPhoneNumber,
              log.reminder.user?.name || 'Patient',
              userLanguage,
            );
          } catch (sweepError) {
            this.logger.error(
              `Failed auto-skipping expired log reference ${log.id}`,
              sweepError,
            );
          }
        }
      } catch (err) {
        this.logger.error(`Failed processing operational timing loop`, err);
      }
    }
  }

  @Cron('0 20 * * 0')
  async triggerWeeklyHealthReports() {
    this.logger.log(
      'Initiating automated Sunday weekly health analytics distribution...',
    );

    // Fetch all registered users
    const users = await this.prisma.user.findMany();

    // Loop and distribute their individual metrics reports
    for (const user of users) {
      await this.analyticsService.processAndSendWeeklyReport(user.phoneNumber);
    }
  }

  /**
   * Analyzes a patient's recent treatment timeline for severe non-compliance.
   * If the last 3 chronological events are SKIPPED or TAKEN_LATE, triggers an S.O.S alert to their mentor.
   */
  private async checkAndTriggerEscalation(
    userPhoneNumber: string,
    userName: string,
    language: 'EN' | 'FR',
  ) {
    try {
      // 1. Fetch the user's last 3 chronological logs
      const recentLogs = await this.prisma.doseLog.findMany({
        where: {
          reminder: { userPhoneNumber: userPhoneNumber },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 3, // Restrict query to just the 3 most recent entries
      });

      // If they haven't accumulated 3 alerts yet, skip calculation
      if (recentLogs.length < 3) return;

      // 2. Evaluate compliance criteria (True if ALL 3 logs are SKIPPED or TAKEN_LATE)
      const isSeverelyNonCompliant = recentLogs.every(
        (log) => log.status === 'SKIPPED' || log.status === 'TAKEN_LATE',
      );

      if (!isSeverelyNonCompliant) return;

      // 3. Query the user table to see if an assigned Treatment Supporter exists
      const userWithMentor = await this.prisma.user.findUnique({
        where: { phoneNumber: userPhoneNumber },
        include: { mentor: true },
      });

      if (!userWithMentor || !userWithMentor.mentor) {
        this.logger.warn(
          `Escalation triggered for ${userPhoneNumber}, but no mentor record is linked.`,
        );
        return;
      }

      const mentor = userWithMentor.mentor;

      // 4. Construct your highly professional S.O.S communication template
      const isFrench = language === 'FR';
      const mentorName = mentor.name || 'Supporter';

      const sosMessage = isFrench
        ? `Bonjour ${mentorName}, le patient ${userName} (${userPhoneNumber}) n'a pas pris correctement ses derniers médicaments (manqués ou pris en retard). Pourriez-vous le contacter pour comprendre la situation et vous assurer qu'il se porte bien ? Merci d'intervenir.`
        : `Hey ${mentorName}, ${userName} with number ${userPhoneNumber} hasn't been taking their medication safely lately (either skipped or taken heavily late). Do you mind checking on them and trying to know why they've not been taking their meds?`;

      // 5. Transmit the alert message to the MENTOR's phone number!
      await this.whatsappService.sendWhatsAppPayload(
        mentor.phoneNumber,
        sosMessage,
      );

      this.logger.log(
        `[🚨 ESCALATION CASCADED] Non-compliance alert dispatched to mentor ${mentor.phoneNumber} for patient ${userPhoneNumber}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed executing Day 7 escalation cascade engine rules for ${userPhoneNumber}`,
        error,
      );
    }
  }
}
