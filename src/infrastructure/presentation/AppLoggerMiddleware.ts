import { ConsoleLogger, Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as ipaddr from 'ipaddr.js';

@Injectable()
export class AppLoggerMiddleware implements NestMiddleware {
  private logger = new ConsoleLogger('HTTP');
  private requestSequence = 0;

  use(request: Request, response: Response, next: NextFunction): void {
    const { ip, secure, method, originalUrl, headers } = request;
    const diagnostics = process.env.XWS_CONNECTION_DIAGNOSTICS === 'true';
    const diagnosticRequestLimit = 512;
    const requestId = diagnostics ? ++this.requestSequence : 0;
    const traceRequest = diagnostics && requestId <= diagnosticRequestLimit;
    const startedNs = traceRequest ? process.hrtime.bigint() : BigInt(0);

    this.logger.setContext(secure ? 'HTTPS' : 'HTTP');

    // converts IPv4-mapped IPv6 addresses to their IPv4 counterparts
    const ip_ipv4 = ipaddr.process(ip);
    const userAgent = request.get('user-agent') || '';

    if (diagnostics && requestId === diagnosticRequestLimit + 1) {
      this.logger.warn(
        `[XWS-HTTP] SUPPRESS wall_ms=${Date.now()} ` +
          `after_requests=${diagnosticRequestLimit}`,
      );
    }

    let finished = false;
    if (traceRequest) {
      this.logger.log(
        `[XWS-HTTP] START id=${requestId} wall_ms=${Date.now()} mono_ns=${startedNs} ` +
          `${method} ${originalUrl} remote=${request.socket.remoteAddress || ''}:` +
          `${request.socket.remotePort || 0} local=${request.socket.localAddress || ''}:` +
          `${request.socket.localPort || 0}`,
      );
      response.once('finish', () => {
        finished = true;
        const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
        this.logger.log(
          `[XWS-HTTP] FINISH id=${requestId} wall_ms=${Date.now()} ` +
            `elapsed_ms=${elapsedMs.toFixed(3)} status=${response.statusCode}`,
        );
      });
    }

    response.on('close', () => {
      const { statusCode } = response;

      const headers_JSON = JSON.stringify(headers);

      this.logger.log(
        `${method} ${originalUrl} ${statusCode} - ${userAgent} ${ip_ipv4.toString()} ${headers_JSON}`,
      );
      if (traceRequest) {
        const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
        this.logger.log(
          `[XWS-HTTP] CLOSE id=${requestId} wall_ms=${Date.now()} ` +
            `elapsed_ms=${elapsedMs.toFixed(3)} status=${statusCode} finished=${finished ? 1 : 0}`,
        );
      }
    });

    next();
  }
}
