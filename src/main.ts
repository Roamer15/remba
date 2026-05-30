import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Force the application to log raw unhandled exceptions
  process.on('unhandledRejection', (reason) => {
    console.error('❌ CRITICAL UNHANDLED REJECTION:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('❌ CRITICAL UNCAUGHT EXCEPTION:', error);
  });

  app.enableCors();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Application is running on port: ${port}`);
}
bootstrap();
