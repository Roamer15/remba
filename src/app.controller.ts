import { Controller, Get, Head } from '@nestjs/common';

@Controller()
export class AppController {
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
