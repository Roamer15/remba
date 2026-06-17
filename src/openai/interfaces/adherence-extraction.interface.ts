export interface AdherenceExtractionResult {
  intent: 'TAKEN' | 'SKIP' | 'UNKNOWN';
  skipReasonCategory?: 'SIDE_EFFECTS' | 'OUT_OF_STOCK' | 'FORGOT' | 'OTHER';
  skipReasonNotes?: string;
  motivationalResponse: string;
}
