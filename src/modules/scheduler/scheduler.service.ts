// src/modules/scheduler/scheduler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsappService: WhatsappService,
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
            timestamp: { lt: fiveHoursAgo }, // "lt" means Less Than (created before 5 hours ago)
          },
          include: {
            reminder: true,
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
}
