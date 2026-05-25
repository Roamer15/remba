/**
 * Structured response payload returned by OpenAI during the initial user onboarding scan.
 */
export interface OnboardingResult {
  detectedLanguage: 'EN' | 'FR';
  cleanedName: string;
  greetingResponse: string;
}

/**
 * Normalized incoming payload extracted directly from the raw Meta webhook JSON.
 */
export interface IncomingMessagePayload {
  from: string;
  text: string;
  profileName: string;
}
