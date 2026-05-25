import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  /**
   * Webhook Verification (GET)
   * Required by Meta/WhatsApp to verify your server's endpoint availability.
   */
  @Get('webhook')
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const verifyToken =
      process.env.WHATSAPP_VERIFY_TOKEN || 'REMBA_SECRET_TOKEN';

    if (mode === 'subscribe' && token === verifyToken) {
      return res.status(HttpStatus.OK).send(challenge);
    }

    return res.status(HttpStatus.FORBIDDEN).end();
  }

  /**
   * Handle Incoming Messages (POST)
   * Receives incoming payloads from users interacting with Remba.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleIncomingMessage(@Body() payload: any) {
    // Extract messaging components safely
    const messageData = this.whatsappService.extractMessageDetails(payload);
    
    if (!messageData) {
      return { status: 'ignored', reason: 'Not a text message event' };
    }

    // Process the text message through the service layer
    await this.whatsappService.processUserMessage(messageData.from, messageData.text);
    
    return { status: 'success' };
  }
}
