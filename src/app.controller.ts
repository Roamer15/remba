import { Controller, Get, Head } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Head()
  getRoot(): string {
    return 'Remba Cloud Engine API Gateway Active';
  }

  @Get('health-check')
  getHealth(): string {
    return 'Remba Core Engine is running smoothly!';
  }
}
