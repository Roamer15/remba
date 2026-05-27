export interface AdherenceExtractionResult {
  intent: 'TAKEN' | 'SKIP' | 'UNKNOWN' | 'TAKEN_LATE';
  skipReasonCategory?: 'SIDE_EFFECTS' | 'OUT_OF_STOCK' | 'FORGOT' | 'OTHER';
  skipReasonNotes?: string;
  motivationalResponse: string;
}
