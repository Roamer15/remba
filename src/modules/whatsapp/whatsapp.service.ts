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
  extractMessagePayload(body: any): {
    from: string;
    text: string;
    profileName: string;
    messageId: string;
    imageId?: string;
    imageMimeType?: string;
  } | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const message = value?.messages?.[0] as MetaMessage | undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const contact = value?.contacts?.[0] as MetaContact | undefined;

      if (!message) return null;

      const profileName = contact?.profile?.name || 'Friend';

      // Text messages
      if (message.type === 'text' && message.text?.body) {
        return {
          from: message.from || '',
          text: message.text.body.trim(),
          profileName,
          messageId: message.id || '',
        };
      }

      // Image messages (e.g. a prescription photo). The caption, if any, is
      // carried as text; the actual bytes are fetched later via the media ID.
      if (message.type === 'image' && message.image?.id) {
        return {
          from: message.from || '',
          text: (message.image.caption || '').trim(),
          profileName,
          messageId: message.id || '',
          imageId: message.image.id,
          imageMimeType: message.image.mime_type,
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
   * Downloads a WhatsApp media object (by media ID) and returns it as a base64
   * data URL suitable for passing to a vision model. Meta requires two
   * authenticated calls: resolve the media URL, then download the bytes.
   */
  async fetchMediaAsDataUrl(mediaId: string): Promise<string> {
    const token = process.env.WHATSAPP_API_TOKEN;
    const graphUrl = process.env.FACEBOOK_ENTRY_URL;

    if (!token) {
      throw new Error('WHATSAPP_API_TOKEN environment variable is not set');
    }
    if (!graphUrl) {
      throw new Error('FACEBOOK_ENTRY_URL environment variable is not set');
    }

    // 1. Resolve the short-lived, authenticated media URL.
    const metaResponse = await axios.get(`${graphUrl}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const mediaUrl = metaResponse.data?.url as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const mimeType = (metaResponse.data?.mime_type as string) || 'image/jpeg';

    if (!mediaUrl) {
      throw new Error(`No media URL returned for media ID ${mediaId}`);
    }

    // 2. Download the raw bytes (still requires the bearer token).
    const fileResponse = await axios.get<ArrayBuffer>(mediaUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });

    const base64 = Buffer.from(fileResponse.data).toString('base64');
    return `data:${mimeType};base64,${base64}`;
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
    const graphUrl = process.env.FACEBOOK_ENTRY_URL;

    if (!phoneNumberId) {
      throw new Error(
        'WHATSAPP_PHONE_NUMBER_ID environment variable is not set',
      );
    }
    if (!accessToken) {
      throw new Error('WHATSAPP_ACCESS_TOKEN environment variable is not set');
    }
    if (!graphUrl) {
      throw new Error('FACEBOOK_ENTRY_URL environment variable is not set');
    }

    const url = `${graphUrl}/${phoneNumberId}/messages`;
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
        this.logger.error('Status:', error.response?.status);
        this.logger.error(
          'Response:',
          JSON.stringify(error.response?.data, null, 2),
        );
      }

      throw error;
    }
  }

  async sendTypingIndicator(messageId: string): Promise<void> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_API_TOKEN;
    const graphUrl = process.env.FACEBOOK_ENTRY_URL;
    if (!phoneNumberId || !token || !graphUrl) {
      this.logger.log(
        'Either WHATSAPP_PHONE_NUMBER or WHATSAPP_API_TOKEN or FACEBOOK_ENTRY_URL is missing',
      );
    }

    const url = `${graphUrl}/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: {
        type: 'text',
      },
    };

    try {
      await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${token}` },
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

  async markMessageAsRead(messageId: string): Promise<void> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_API_TOKEN;
    const graphUrl = process.env.FACEBOOK_ENTRY_URL;
    if (!phoneNumberId || !token || !graphUrl) {
      this.logger.log(
        'Either WHATSAPP_PHONE_NUMBER or WHATSAPP_API_TOKEN or FACEBOOK_ENTRY_URL is missing',
      );
    }

    const url = `${graphUrl}/${phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    };

    try {
      await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      const error = err as Error;
      if (axios.isAxiosError(error)) {
        this.logger.error('Status:', error.response?.status);
        this.logger.error(
          'Response:',
          JSON.stringify(error.response?.data, null, 2),
        );
      }

      throw error;
    }
  }
}
