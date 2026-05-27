import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { MessageHandlerService } from './message-handler.service';
import { OpenaiService } from 'src/openai/openai.service';
import { PrismaService } from 'src/prisma.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { AnalyticsService } from '../scheduler/analytics.service';

@Module({
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    MessageHandlerService,
    OpenaiService,
    PrismaService,
    SchedulerService,
    AnalyticsService,
  ],
})
export class WhatsappModule {}
