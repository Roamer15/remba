import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  /**
   * Normalizes incoming webhook structures (Meta Cloud API style)
   * to extract sender details and message bodies.
   */
  extractMessageDetails(payload: any): { from: string; text: string } | null {
    try {
      const entry = payload?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];

      if (message && message.type === 'text') {
        return {
          from: message.from, // Sender's phone number
          text: message.text.body.trim(),
        };
      }
    } catch (error) {
      this.logger.error(
        'Failed parsing WhatsApp webhook payload architecture',
        error,
      );
    }
    return null;
  }
}
