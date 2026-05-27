// src/openai/openai.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { OpenAI } from 'openai';
import { OnboardingResult } from 'src/modules/whatsapp/interfaces/onboarding-result.interface';
import { ScheduleExtractionResult } from './interfaces/schedule-interaction.interface';
import { AdherenceExtractionResult } from './interfaces/adherence-extraction.interface';
import { WeeklyMetrics } from './interfaces/weekly-report.interface';

@Injectable()
export class OpenaiService {
  private openai: OpenAI;
  private readonly logger = new Logger(OpenaiService.name);

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    this.openai = new OpenAI({
      apiKey: apiKey,
    });
  }

  /**
   * Parses the first message from a stranger to determine language, clean their profile name,
   * and generate an empathetic localized greeting.
   */
  async processNewUserOnboarding(
    rawMessage: string,
    whatsappProfileName: string,
  ): Promise<OnboardingResult> {
    try {
      // Sanitize user inputs to prevent prompt injection
      const sanitizedMessage = this.sanitizeInput(rawMessage);
      const sanitizedName = this.sanitizeInput(whatsappProfileName);

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are Remba, a warm, professional virtual health companion in Cameroon assisting patients with chronic conditions (HIV, TB, hypertension).
            
            Your task is to parse onboarding details from a new user payload and respond with a strict JSON format.
            
            CRITICAL INSTRUCTIONS:
            1. Clean the provided WhatsApp profile name by stripping out emojis, symbols, or icons, leaving only clean text. If the name is blank or only emojis, default it to a respectful title like "Friend".
            2. Detect if the user's message is written in English or French. If ambiguous, default to "EN".
            3. Generate a warm, reassuring greeting response using the cleaned name in their detected language. Briefly introduce Remba as their medication buddy, explain that you are here to help them take their doses on time, and ask them what medication they would like to set up a reminder for.
            
            You MUST respond ONLY with a valid JSON object matching this schema:
            {
              "detectedLanguage": "EN" | "FR",
              "cleanedName": "string",
              "greetingResponse": "string"
            }`,
          },
          {
            role: 'user',
            content: `WhatsApp Profile Name: "${sanitizedName}"\nUser Message: "${sanitizedMessage}"`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });

      // Safely access response with optional chaining and null coalescing
      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No content in OpenAI response');
      }

      const parsedResult = JSON.parse(content) as OnboardingResult;
      return parsedResult;
    } catch (error) {
      this.logger.error(
        'OpenAI onboarding extraction failed. Falling back to safe defaults.',
        error instanceof Error ? error : new Error(String(error)),
      );
      return {
        detectedLanguage: 'EN',
        cleanedName: 'Friend',
        greetingResponse:
          "Hello! Welcome to Remba, your medication reminder buddy. Let's make sure you never miss a dose. What medication would you like to set up a reminder for today?",
      };
    }
  }

  /**
   * Sanitize user input to prevent prompt injection attacks
   */
  private sanitizeInput(input: string): string {
    // Limit input length to prevent excessively long prompts
    const maxLength = 500;
    let sanitized = input.slice(0, maxLength);

    // Remove potentially dangerous escape sequences but preserve regular text
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    return sanitized.trim();
  }

  /**
   * Parses natural text strings from existing users to extract structured medication regimes.
   * Maps vague descriptions (morning, evening, etc.) into definitive 24h string values.
   */
  async extractMedicationSchedules(
    incomingText: string,
    language: 'EN' | 'FR',
    userName: string,
  ): Promise<ScheduleExtractionResult> {
    try {
      const sanitizedMessage = this.sanitizeInput(incomingText);

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are Remba, a helpful, empathetic medication scheduling assistant. Your job is to extract medication names and precise times from natural text.
            
            Context: You are talking to a patient named ${userName}. Their preferred language code is ${language}. You MUST respond in this language.
            
            CRITICAL PROCESSING RULES:
            1. If the user mentions vague periods instead of exact numbers, map them to these 24-hour markers:
               - Morning / Matin -> "08:00"
               - Afternoon / Après-midi -> "13:00"
               - Evening / Soir -> "19:00"
               - Night / Nuit -> "21:00"
            2. If they provide multiple times or specify something like "twice a day (8am and 8pm)", generate multiple entries in the array for that medication name.
            3. GUARDRAIL: If the user's text is unrelated to medical setups (e.g., "What is your name?", "Thank you", "I am tired"), leave the "remindersFound" array completely EMPTY. In the "confirmationMessage", provide a brief polite answer to their comment, but strictly remind them that they need to add their medication details first before proceeding with a wider discussion.
            
            You MUST respond ONLY with a valid JSON object matching this schema:
            {
              "remindersFound": [
                { "medicationName": "string", "reminderTime": "string (format HH:MM)" }
              ],
              "confirmationMessage": "string"
            }`,
          },
          {
            role: 'user',
            content: `Message to parse: "${sanitizedMessage}"`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1, // Keep temperature low for maximum structural accuracy
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(
          'No content returned from OpenAI schedule extraction token payload',
        );
      }

      return JSON.parse(content) as ScheduleExtractionResult;
    } catch (error) {
      this.logger.error(
        'Failed extracting schedules from text layout stream',
        error instanceof Error ? error : new Error(String(error)),
      );

      // Fallback response safely typed to meet contract constraints
      return {
        remindersFound: [],
        confirmationMessage:
          language === 'FR'
            ? "Désolé, je n'ai pas pu structurer vos rappels. Veuillez spécifier le nom du médicament et l'heure (ex: Paracétamol à 8h)."
            : "Sorry, I couldn't structure your reminders clearly. Please specify the drug name and time (e.g., Paracetamol at 8am).",
      };
    }
  }

  /**
   * Analyzes customer check-ins when they don't match strict keywords.
   * Classifies intents and extracts barriers (notes) for the adherence reports.
   */
  async parseAdherenceResponse(
    incomingText: string,
    language: 'EN' | 'FR',
    userName: string,
  ): Promise<AdherenceExtractionResult> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are Remba, an empathetic virtual health companion in Cameroon tracking patient adherence for chronic therapies.
            
            Analyze the user's reply text and determine their action intent.
            
            CLASSIFICATION RULES:
            - intent: "TAKEN" if they confirm they took their medication (even if late or in local slang/phrasing).
            - intent: "SKIP" if they missed it, cannot take it, or are expressing a barrier.
            - intent: "UNKNOWN" if it is general conversational chatter.
            
            IF INTENT IS "SKIP":
            1. Categorize their primary barrier into skipReasonCategory ("SIDE_EFFECTS", "OUT_OF_STOCK", "FORGOT", "OTHER").
            2. Summarize their barrier concisely in skipReasonNotes in English (max 10 words, e.g., "Experiencing severe dizziness").
            
            GENERATING THE MOTIVATIONAL RESPONSE:
            - If TAKEN: Provide a very brief, high-energy cheer (1 sentence) using their preference language (${language}). You can use minor local encouragement or emojis like 🔥.
            - If SKIP: Respond with deep medical empathy (1-2 sentences). Validate their struggle, encourage them to stay strong, and gently advise them to contact their local clinic provider if health anomalies persist.
            
            You MUST respond ONLY with a valid JSON object matching this schema:
            {
              "intent": "TAKEN" | "SKIP" | "UNKNOWN",
              "skipReasonCategory": "SIDE_EFFECTS" | "OUT_OF_STOCK" | "FORGOT" | "OTHER" | null,
              "skipReasonNotes": "string" | null,
              "motivationalResponse": "string"
            }`,
          },
          {
            role: 'user',
            content: `Patient Name: ${userName}\nMessage: "${incomingText}"`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty payload exception');

      return JSON.parse(content) as AdherenceExtractionResult;
    } catch (error) {
      this.logger.error(
        'Failed to parse adherence text response payload via OpenAI',
        error,
      );
      return {
        intent: 'UNKNOWN',
        motivationalResponse:
          language === 'FR'
            ? "Merci pour votre message. S'il s'agit de votre traitement, répondez 'TAKEN' pour valider."
            : "Thank you for your message. If this is regarding your medication, please reply 'TAKEN' to confirm.",
      };
    }
  }

  /**
   * Generates an automated weekly clinical health analysis review.
   * Modulates behavioral coaching tone strictly based on computed compliance rates.
   */
  async generateWeeklyMedicalReview(
    metrics: WeeklyMetrics,
    language: 'EN' | 'FR',
    userName: string,
  ): Promise<string> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are Remba, a firm yet compassionate virtual medical specialist tracking treatment logs in Cameroon.
            
            You are writing a weekly health summary review for a patient named ${userName}. Language preference: ${language}.
            
            TONE ADJUSTMENT CRITERIA BASED ON ADHERENCE RATE (${metrics.adherenceRate}%):
            1. POOR COMPLIANCE (Adherence < 80%): Use a stern, serious, and urgent tone (a medical scolding). Strongly emphasize that missing chronic treatments causes drug resistance, treatment failure, and severe clinical deterioration. Demand higher responsibility, address their high Skip Rate (${metrics.skipRate}%), and insist they get back on track.
            2. MODERATE COMPLIANCE (Adherence 80% - 94%): Use a firm, encouraging, coaching tone. Note that they are doing well but highlight their Late Rate (${metrics.lateRate}%) or Skip Rate if applicable, reminding them that precision timing maximizes therapy success.
            3. PERFECT COMPLIANCE (Adherence 95% - 100%): Use a warm, celebratory, high-energy tone. Express absolute pride, congratulate their amazing milestone streak, and encourage them to continue maintaining this gold standard for their long-term health.
            
            Keep the content punchy, empathetic but direct, and restricted entirely to the medical domain (max 4-5 sentences). Do not wrap inside JSON, return the raw message string output directly.`,
          },
          {
            role: 'user',
            content: `Weekly Performance Figures for ${userName}:
            - Adherence Rate: ${metrics.adherenceRate}%
            - Skip Rate: ${metrics.skipRate}%
            - Late Rate: ${metrics.lateRate}%
            - Total Expected Doses: ${metrics.totalExpectedDoses}`,
          },
        ],
        temperature: 0.4,
      });

      return response.choices?.[0]?.message?.content || 'No review generated.';
    } catch (error) {
      this.logger.error(
        'Failed generating weekly clinical health review analysis via OpenAI',
        error,
      );
      return language === 'FR'
        ? 'Voici votre bilan hebdomadaire : Continuez à prendre soin de votre santé au quotidien !'
        : 'Here is your weekly health summary review: Please continue prioritizing your dosage timing daily!';
    }
  }
}
