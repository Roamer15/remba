import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  it('exposes the root gateway status', () => {
    expect(appController.getRoot()).toContain('Remba');
  });

  it('exposes a health-check endpoint', () => {
    expect(appController.getHealth()).toContain('Remba');
  });
});
