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
  /** Media ID of an attached image (e.g. a prescription photo), if present. */
  imageId?: string;
  imageMimeType?: string;
  /** Media ID of an attached voice note / audio message, if present. */
  audioId?: string;
  audioMimeType?: string;
}
