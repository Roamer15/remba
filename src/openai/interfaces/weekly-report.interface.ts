export interface WeeklyMetrics {
  totalExpectedDoses: number;
  adherenceRate: number;
  skipRate: number;
  lateRate: number;
}

export interface WeeklyReportResult {
  metrics: WeeklyMetrics;
  coachingMessage: string;
}
