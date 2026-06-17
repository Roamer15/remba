// src/modules/scheduler/scheduler.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { AnalyticsService } from './analytics.service';
import axios from 'axios';

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
    const baseServerDate = new Date();
    this.logger.log(
      `Cron loop ticking. System UTC Hour: ${baseServerDate.getUTCHours()}:${baseServerDate.getUTCMinutes()}`,
    );

    const activeReminders = await this.prisma.reminder.findMany({
      where: { isActive: true },
      include: { user: true },
    });

    // Catch-up window: a reminder fires if we are within this many minutes
    // PAST its scheduled time. This makes dispatch resilient to missed/late
    // cron ticks in production (container throttling, restarts, GC pauses)
    // instead of requiring the tick to land on the exact target minute.
    const DISPATCH_WINDOW_MINUTES = 10;
    // Suppress a re-send if this reminder already produced a dose log recently.
    // Must be longer than the window but shorter than a day so that the next
    // day's dose still fires.
    const DEDUPE_LOOKBACK_HOURS = 18;

    for (const reminder of activeReminders) {
      try {
        const now = new Date();
        const userOffset = reminder.user.timezoneOffset;

        // Current local time and the target time, both as minutes since midnight.
        const utcMinutesOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
        let localMinutesOfDay = utcMinutesOfDay + userOffset * 60;
        localMinutesOfDay = ((localMinutesOfDay % 1440) + 1440) % 1440;

        const [targetHour, targetMinute] = reminder.reminderTime
          .split(':')
          .map((part) => parseInt(part, 10));

        if (Number.isNaN(targetHour) || Number.isNaN(targetMinute)) {
          this.logger.warn(
            `Skipping reminder ${reminder.id} with malformed reminderTime "${reminder.reminderTime}"`,
          );
          continue;
        }

        const targetMinutesOfDay = targetHour * 60 + targetMinute;

        // Minutes elapsed since the dose was due (handles midnight wrap-around).
        let minutesSinceDue = localMinutesOfDay - targetMinutesOfDay;
        if (minutesSinceDue < -720) minutesSinceDue += 1440;

        if (minutesSinceDue < 0 || minutesSinceDue >= DISPATCH_WINDOW_MINUTES) {
          const localClock = `${String(Math.floor(localMinutesOfDay / 60)).padStart(2, '0')}:${String(localMinutesOfDay % 60).padStart(2, '0')}`;
          this.logger.debug(
            `No dispatch for ${reminder.id}: target=${reminder.reminderTime}, localNow=${localClock}, offset=${userOffset}, minutesSinceDue=${minutesSinceDue}, utc=${baseServerDate.toISOString()}`,
          );
          continue;
        }

        // Idempotency: only one alert per reminder per scheduled dose.
        const dedupeSince = new Date(
          now.getTime() - DEDUPE_LOOKBACK_HOURS * 60 * 60 * 1000,
        );
        const existingLog = await this.prisma.doseLog.findFirst({
          where: {
            reminderId: reminder.id,
            timestamp: { gte: dedupeSince },
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
          `Alert delivered for reminder ${reminder.id} (target ${reminder.reminderTime}, ${minutesSinceDue}m after due) to ${reminder.userPhoneNumber}`,
        );
      } catch (err) {
        this.logger.error(
          `Failed processing operational timing loop for reminder ${reminder.id}`,
          err,
        );
      }
    }

    // ==========================================
    // PHASE 2: SWEEP ABANDONED LOGS (OUTSIDE MAIN LOOP)
    // ==========================================
    try {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);

      const abandonedLogs = await this.prisma.doseLog.findMany({
        where: {
          status: 'PENDING',
          timestamp: { lt: fiveHoursAgo },
        },
        include: {
          reminder: {
            include: { user: true },
          },
        },
      });

      for (const log of abandonedLogs) {
        try {
          await this.prisma.$transaction(async (tx) => {
            await tx.doseLog.update({
              where: { id: log.id },
              data: {
                status: 'SKIPPED',
                notes: 'Auto-skipped: No user response within 5 hours.',
              },
            });

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
    } catch (timeoutEngineError) {
      this.logger.error(
        `Failed running timeout sweeping engine execution pass`,
        timeoutEngineError,
      );
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
      // Fetch the user's last 3 chronological logs
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

      // Evaluate compliance criteria (True if ALL 3 logs are SKIPPED or TAKEN_LATE)
      const isSeverelyNonCompliant = recentLogs.every(
        (log) => log.status === 'SKIPPED' || log.status === 'TAKEN_LATE',
      );

      if (!isSeverelyNonCompliant) return;

      // Query the user table to see if an assigned Treatment Supporter exists
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

      // Construct your highly professional S.O.S communication template
      const isFrench = language === 'FR';
      const mentorName = mentor.name || 'Supporter';

      const sosMessage = isFrench
        ? `Bonjour ${mentorName}, le patient ${userName} (${userPhoneNumber}) n'a pas pris correctement ses derniers médicaments (manqués ou pris en retard). Pourriez-vous le contacter pour comprendre la situation et vous assurer qu'il se porte bien ? Merci d'intervenir.`
        : `Hey ${mentorName}, ${userName} with number ${userPhoneNumber} hasn't been taking their medication safely lately (either skipped or taken heavily late). Do you mind checking on them and trying to know why they've not been taking their meds?`;

      // Transmit the alert message to the MENTOR's phone number!
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

  /**
   * Hackathon Optimization: Prevents Render free-tier containers from sleeping.
   * Fires a lightweight internal heartbeat ping every 10 minutes.
   */
  @Cron('*/10 * * * *')
  async keepContainerWarm() {
    try {
      // Fallback to localhost if the production URL variable isn't injected yet
      const liveUrl = process.env.PRODUCTION_URL || 'http://localhost:3000';

      this.logger.log(
        `[🔥 HEARTBEAT] Dispatching warm-engine ping to: ${liveUrl}/health-check`,
      );

      const response = await axios.get(`${liveUrl}/health-check`);
      this.logger.log(`[✅ HEARTBEAT] Server responded with: ${response.data}`);
    } catch (error) {
      this.logger.error(
        '[⚠️ HEARTBEAT] Self-ping failed. Make sure PRODUCTION_URL environment variable is set on Render.',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
