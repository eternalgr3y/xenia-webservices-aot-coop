import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { XeniaModule } from './../src/xenia.module';

describe('Application startup and address middleware (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [XeniaModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/whoami (GET)', () => {
    return request(app.getHttpServer())
      .get('/whoami')
      .expect(200)
      .expect({ address: '127.0.0.1' });
  });
});
