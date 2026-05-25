// src/openai/openai.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { OpenAI } from 'openai';
import { OnboardingResult } from 'src/modules/whatsapp/interfaces/onboarding-result.interface';

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
}
