import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';

// 🛡️ Custom filter to bypass NestJS error masking
@Catch()
export class ForceAllErrorsToConsoleFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    console.error('================ 🔥 CRITICAL WEBHOOK ERROR DETECTED 🔥 ================');
    if (exception instanceof Error) {
      console.error(`Message: ${exception.message}`);
      console.error(`Stack: ${exception.stack}`);
    } else {
      console.error('Unknown Exception:', exception);
    }
    console.error('=======================================================================');

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    response.status(status).json({
      statusCode: status,
      message: exception.message || 'Internal server error',
    });
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Bind the error buster globally
  app.useGlobalFilters(new ForceAllErrorsToConsoleFilter());

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on port: ${port}`);
}
bootstrap();