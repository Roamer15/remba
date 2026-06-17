// src/modules/scheduler/analytics.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma.service';
import { OpenaiService } from 'src/openai/openai.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { WeeklyMetrics } from 'src/openai/interfaces/weekly-report.interface';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openaiService: OpenaiService,
    private readonly whatsappService: WhatsappService,
  ) {}

  /**
   * Compiles and transmits 7-day retrospective analytics reports for a given user profile.
   */
  async processAndSendWeeklyReport(phoneNumber: string): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { phoneNumber },
      });

      if (!user) throw new Error('Target user profile not found');

      // 1. Calculate the 7-day historical time frame boundary
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // 2. Query all dose records matching this specific window frame via Prisma
      const weeklyLogs = await this.prisma.doseLog.findMany({
        where: {
          reminder: { userPhoneNumber: phoneNumber },
          timestamp: { gte: sevenDaysAgo },
        },
      });

      const totalExpectedDoses = weeklyLogs.length;

      // Handle baseline fallback state if no records exist yet for this week
      if (totalExpectedDoses === 0) {
        const initialText =
          user.language === 'FR'
            ? `Bonjour ${user.name || 'Ami'}, pas assez de données cette semaine pour générer votre bilan. Continuez à enregistrer vos doses !`
            : `Hi ${user.name || 'Friend'}, not enough logging history captured this week to compute your analytics dashboard report. Keep tracking!`;

        await this.whatsappService.sendWhatsAppPayload(
          phoneNumber,
          initialText,
        );
        return;
      }

      // 3. Apply your precise structural performance math formulas (Question 1 Blueprint)
      const takenCount = weeklyLogs.filter(
        (l) => l.status === 'TAKEN' || l.status === 'TAKEN_LATE',
      ).length;
      const lateCount = weeklyLogs.filter(
        (l) => l.status === 'TAKEN_LATE',
      ).length;
      const skippedCount = weeklyLogs.filter(
        (l) => l.status === 'SKIPPED',
      ).length;

      const adherenceRate = Math.round((takenCount / totalExpectedDoses) * 100);
      const skipRate = Math.round((skippedCount / totalExpectedDoses) * 100);
      const lateRate = Math.round((lateCount / totalExpectedDoses) * 100);

      const computedMetrics: WeeklyMetrics = {
        totalExpectedDoses,
        adherenceRate,
        skipRate,
        lateRate,
      };

      // 4. Pass compiled metrics straight to your clinical review engine
      const languageCode = (user.language as 'EN' | 'FR') || 'EN';
      const reviewNarrative =
        await this.openaiService.generateWeeklyMedicalReview(
          computedMetrics,
          languageCode,
          user.name || 'Patient',
        );

      // 5. Structure the complete dashboard visualization presentation string
      const reportHeader =
        languageCode === 'FR'
          ? ` *BILAN DE SANTÉ HEBDOMADAIRE* \n--------------------------------\n• Taux d'observance : ${adherenceRate}%\n• Taux d'omission (Skip) : ${skipRate}%\n• Taux de retard : ${lateRate}%\n• Total des doses attendues : ${totalExpectedDoses}\n\n📝 *Rapport Médical de Remba :*\n`
          : ` *WEEKLY MEDICAL DASHBOARD REPORT* \n--------------------------------\n• Adherence Score: ${adherenceRate}%\n• Skip Barrier Rate: ${skipRate}%\n• Delay/Late Rate: ${lateRate}%\n• Total Logged Trackers: ${totalExpectedDoses}\n\n📝 *Remba Clinical Review :*\n`;

      const completeReportText = `${reportHeader}${reviewNarrative}`;

      // 6. Transmit metrics suite to client device via WhatsApp
      await this.whatsappService.sendWhatsAppPayload(
        phoneNumber,
        completeReportText,
      );
      this.logger.log(
        `Weekly medical metrics report successfully generated and sent to: ${phoneNumber}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed executing weekly metrics compiler loop for ${phoneNumber}`,
        err,
      );
    }
  }
}
