import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { XeniaModule } from './src/xenia.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import PresentationSettings from 'src/infrastructure/presentation/settings/PresentationSettings';
import PersistanceSettings from 'src/infrastructure/persistance/settings/PersistanceSettings';
import compression from 'compression';
import helmet from 'helmet';
import { ConsoleLogger } from '@nestjs/common';
import fs from 'fs';
import { monitorEventLoopDelay } from 'perf_hooks';
import { isIP } from 'net';

async function bootstrap() {
  const logger = new ConsoleLogger('Main');

  const envs = new PersistanceSettings().get();

  if (envs.mongoURI == '') {
    logger.error(`MONGO_URI is undefined!`);
  }

  const app = await NestFactory.create<NestExpressApplication>(XeniaModule, {
    rawBody: true,
  });

  const SSL_enabled = envs.SSL == 'true';
  const Swagger_enabled = envs.swagger_API == 'true';
  const Heroku_Nginx_enabled = envs.heroku_nginx == 'true';
  const Nginx_enabled = envs.nginx == 'true';
  const XStorage_enabled = envs.xstorage == 'true';

  if (Swagger_enabled) {
    const config = new DocumentBuilder()
      .setTitle('Xenia Web API')
      .setDescription('')
      .setVersion('1.0.0')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);
  }

  app.enableCors();
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': [
            "'self'",
            "'unsafe-inline'",
            "'sha256-/JqT3SQfawRcv/BIHPThkBvs0OEvtFFmqPF/lYI/Cxo='",
          ],
          upgradeInsecureRequests: SSL_enabled ? [] : null,
        },
      },
    }),
  );
  app.use(compression());

  // Support Heroku
  const PORT = process.env.PORT || new PresentationSettings().get().port;
  const bindAddress = process.env.XWS_BIND_ADDRESS || '127.0.0.1';
  const allowNonLoopback = process.env.XWS_ALLOW_NON_LOOPBACK === 'true';
  if (isIP(bindAddress) === 0) {
    throw new Error(`XWS_BIND_ADDRESS is not a numeric IP: ${bindAddress}`);
  }
  if (
    bindAddress !== '127.0.0.1' &&
    bindAddress !== '::1' &&
    !allowNonLoopback
  ) {
    throw new Error(
      'Non-loopback XWS_BIND_ADDRESS requires XWS_ALLOW_NON_LOOPBACK=true',
    );
  }

  if (Heroku_Nginx_enabled || Nginx_enabled) {
    // Trust the first proxy (express)
    app.set('trust proxy', true);
  }

  const connectionDiagnostics =
    process.env.XWS_CONNECTION_DIAGNOSTICS === 'true';
  const server = app.getHttpServer();
  if (connectionDiagnostics) {
    const diagnosticConnectionLimit = 512;
    const diagnosticLoopWarningLimit = 64;
    let connectionSequence = 0;
    let loopWarningsEmitted = 0;
    server.on('connection', (socket) => {
      const connectionId = ++connectionSequence;
      if (connectionId === diagnosticConnectionLimit + 1) {
        logger.warn(
          `[XWS-TCP] SUPPRESS wall_ms=${Date.now()} ` +
            `after_connections=${diagnosticConnectionLimit}`,
        );
      }
      if (connectionId > diagnosticConnectionLimit) return;
      const startedNs = process.hrtime.bigint();
      logger.log(
        `[XWS-TCP] CONNECTION id=${connectionId} wall_ms=${Date.now()} ` +
          `mono_ns=${startedNs} remote=${socket.remoteAddress || ''}:` +
          `${socket.remotePort || 0} local=${socket.localAddress || ''}:` +
          `${socket.localPort || 0}`,
      );
      socket.once('close', (hadError) => {
        const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
        logger.log(
          `[XWS-TCP] CLOSE id=${connectionId} wall_ms=${Date.now()} ` +
            `elapsed_ms=${elapsedMs.toFixed(3)} error=${hadError ? 1 : 0}`,
        );
      });
      socket.once('error', (error) => {
        logger.warn(
          `[XWS-TCP] ERROR id=${connectionId} wall_ms=${Date.now()} ` +
            `code=${(error as NodeJS.ErrnoException).code || ''}`,
        );
      });
    });

    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelay.enable();
    const eventLoopTimer = setInterval(() => {
      const maxMs = eventLoopDelay.max / 1e6;
      if (maxMs >= 100 && loopWarningsEmitted < diagnosticLoopWarningLimit) {
        loopWarningsEmitted++;
        logger.warn(
          `[XWS-LOOP] wall_ms=${Date.now()} max_ms=${maxMs.toFixed(3)} ` +
            `mean_ms=${(eventLoopDelay.mean / 1e6).toFixed(3)}`,
        );
      } else if (
        maxMs >= 100 &&
        loopWarningsEmitted === diagnosticLoopWarningLimit
      ) {
        loopWarningsEmitted++;
        logger.warn(
          `[XWS-LOOP] SUPPRESS wall_ms=${Date.now()} ` +
            `after_warnings=${diagnosticLoopWarningLimit}`,
        );
      }
      eventLoopDelay.reset();
    }, 5000);
    eventLoopTimer.unref();
    server.once('close', () => {
      clearInterval(eventLoopTimer);
      eventLoopDelay.disable();
    });
  }

  // Heroku + Nginx
  if (Heroku_Nginx_enabled) {
    // Listen to ngnix socket
    await app.listen('/tmp/nginx.socket');

    // Let Ngnix know we want to start serving from the proxy
    fs.openSync('/tmp/app-initialized', 'w');
  } else {
    // Same-PC co-op is loopback-only by default. LAN exposure must be explicit.
    await app.listen(PORT, bindAddress);
  }

  logger.debug(``);
  logger.debug(`Swagger API:\t ${Swagger_enabled ? 'Enabled' : 'Disabled'}`);
  logger.debug(`SSL:\t\t ${SSL_enabled ? 'Enabled' : 'Disabled'}`);
  logger.debug(`Nginx:\t\t ${Nginx_enabled ? 'Enabled' : 'Disabled'}`);
  logger.debug(
    `Heroku & Nginx:\t ${Heroku_Nginx_enabled ? 'Enabled' : 'Disabled'}`,
  );
  logger.debug(`XStorage:\t\t ${XStorage_enabled ? 'Enabled' : 'Disabled'}`);
  logger.debug(`Bind address:\t ${bindAddress}`);
  logger.debug(``);
  logger.debug(`Application is running on: ${await app.getUrl()}`);
}
void bootstrap();
