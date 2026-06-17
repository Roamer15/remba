// src/openai/openai.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { OpenAI } from 'openai';
import { OnboardingResult } from 'src/modules/whatsapp/interfaces/onboarding-result.interface';
import { WeeklyMetrics } from './interfaces/weekly-report.interface';
import {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources.js';

@Injectable()
export class OpenaiService {
  private openai: OpenAI;
  private readonly model = 'gpt-4o-mini';
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
   * Runs a single tool-enabled chat completion for the agent loop.
   * Returns the assistant message, which is either a final text reply
   * (message.content) or a set of tool calls (message.tool_calls) for the
   * caller to execute and feed back.
   */
  async runToolCompletion(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    temperature = 0.4,
  ): Promise<ChatCompletionMessage> {
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature,
    });
    return response.choices[0].message;
  }

  /**
   * Calls OpenAI API with JSON structured output format.
   * Enforces valid JSON responses matching a defined schema.
   */
  private async callJsonStructuredApi(
    messages: ChatCompletionMessageParam[],
    temperature: number,
  ) {
    return await this.openai.chat.completions.create({
      model: this.model,
      messages,
      response_format: { type: 'json_object' },
      temperature,
    });
  }

  /**
   * Utility function to pause execution for a specified duration in milliseconds.
   * Used to implement exponential backoff or delays between retry attempts.
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Calls OpenAI API with JSON structured output and automatic retry logic.
   * Retries with exponential backoff if empty responses are received.
   */
  private async callJsonStructuredApiWithRetry(
    messages: ChatCompletionMessageParam[],
    temperature: number,
    maxRetries: number = 3,
    baseDelayMs: number = 500,
  ) {
    let lastError: Error | null = null;
    let delayMs = baseDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.callJsonStructuredApi(
          messages,
          temperature,
        );
        const content = response.choices?.[0]?.message?.content;

        if (content) {
          if (attempt > 0) {
            this.logger.log(
              `Successfully retrieved content on attempt ${attempt + 1}/${maxRetries + 1}`,
            );
          }
          return response;
        }

        // Content is empty, retry if attempts remaining
        if (attempt < maxRetries) {
          this.logger.warn(
            `Attempt ${attempt + 1}/${maxRetries + 1}: Empty response from OpenAI, retrying in ${delayMs}ms`,
          );
          await this.sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 5000); // Exponential backoff, cap at 5s
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          this.logger.warn(
            `Attempt ${attempt + 1}/${maxRetries + 1}: API call failed, retrying in ${delayMs}ms`,
            lastError,
          );
          await this.sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 5000); // Exponential backoff, cap at 5s
        }
      }
    }

    // All retries exhausted
    throw (
      lastError ||
      new Error('No content returned from OpenAI after all retry attempts')
    );
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
      const messagePayload = [
        {
          role: 'system' as const,
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
          role: 'user' as const,
          content: `WhatsApp Profile Name: "${sanitizedName}"\nUser Message: "${sanitizedMessage}"`,
        },
      ];

      const response = await this.callJsonStructuredApiWithRetry(
        messagePayload,
        0.3,
      );

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
   * Generates an automated weekly clinical health analysis review.
   * Modulates behavioral coaching tone strictly based on computed compliance rates.
   */
  async generateWeeklyMedicalReview(
    metrics: WeeklyMetrics,
    language: 'EN' | 'FR',
    userName: string,
  ): Promise<string> {
    try {
      const messages = [
        {
          role: 'system' as const,
          content: `You are Remba, a firm yet compassionate virtual medical specialist tracking treatment logs in Cameroon.

            You are writing a weekly health summary review for a patient named ${userName}. Language preference: ${language}.

            TONE ADJUSTMENT CRITERIA BASED ON ADHERENCE RATE (${metrics.adherenceRate}%):
            1. POOR COMPLIANCE (Adherence < 80%): Use a stern, serious, and urgent tone (a medical scolding). Strongly emphasize that missing chronic treatments causes drug resistance, treatment failure, and severe clinical deterioration. Demand higher responsibility, address their high Skip Rate (${metrics.skipRate}%), and insist they get back on track.
            2. MODERATE COMPLIANCE (Adherence 80% - 94%): Use a firm, encouraging, coaching tone. Note that they are doing well but highlight their Late Rate (${metrics.lateRate}%) or Skip Rate if applicable, reminding them that precision timing maximizes therapy success.
            3. PERFECT COMPLIANCE (Adherence 95% - 100%): Use a warm, celebratory, high-energy tone. Express absolute pride, congratulate their amazing milestone streak, and encourage them to continue maintaining this gold standard for their long-term health.

            Keep the content punchy, empathetic but direct, and restricted entirely to the medical domain (max 4-5 sentences). Do not wrap inside JSON, return the raw message string output directly.`,
        },
        {
          role: 'user' as const,
          content: `Weekly Performance Figures for ${userName}:
            - Adherence Rate: ${metrics.adherenceRate}%
            - Skip Rate: ${metrics.skipRate}%
            - Late Rate: ${metrics.lateRate}%
            - Total Expected Doses: ${metrics.totalExpectedDoses}`,
        },
      ];
      const response = await this.callJsonStructuredApiWithRetry(messages, 0.4);

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
