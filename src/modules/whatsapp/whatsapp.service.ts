import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { MetaContact, MetaMessage } from './interfaces/meta-webhook.interface';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  /**
   * Normalizes incoming webhook structures (Meta Cloud API style)
   * to extract sender details and message bodies.
   */
  extractMessagePayload(
    body: any,
  ): { from: string; text: string; profileName: string } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const message = value?.messages?.[0] as MetaMessage | undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const contact = value?.contacts?.[0] as MetaContact | undefined;

      // Make sure we are only processing text messages for the MVP
      if (message && message.type === 'text' && message.text?.body) {
        return {
          from: message.from || '', // e.g., "16505551234"
          text: message.text.body.trim(), // e.g., "Does it come in another color?"
          profileName: contact?.profile?.name || 'Friend', // e.g., "Sheena Nelson"
        };
      }
    } catch (error) {
      this.logger.error(
        'Failed parsing Meta WhatsApp payload structure',
        error,
      );
    }
    return null;
  }

  /**
   * Outbound communication engine that transmits text replies back to the user via WhatsApp.
   * Currently runs in Dev/Sandbox mode via local logs so you can build fast without Meta blockades.
   */
  async sendWhatsAppPayload(to: string, messageBody: string): Promise<void> {
    this.logger.log(`[OUTBOUND WHATSAPP] Sending to ${to}: "${messageBody}"`);

    // Validate required environment variables
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_API_TOKEN;

    if (!phoneNumberId) {
      throw new Error(
        'WHATSAPP_PHONE_NUMBER_ID environment variable is not set',
      );
    }
    if (!accessToken) {
      throw new Error('WHATSAPP_ACCESS_TOKEN environment variable is not set');
    }

    const url = `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to.replace('+', ''),
      type: 'text',
      text: {
        body: messageBody,
      },
    };
    try {
      await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
    } catch (err) {
      const error = err as Error;
      if (axios.isAxiosError(error)) {
        console.log('Status:', error.response?.status);
        console.log('Response:', JSON.stringify(error.response?.data, null, 2));
      }

      throw error;
    }
  }

  /**
   * Process incoming message from a user (new or existing)
   */
  processUserMessage(phoneNumber: string, message: string): void {
    this.logger.log(`Processing message from ${phoneNumber}: "${message}"`);
  }
}
