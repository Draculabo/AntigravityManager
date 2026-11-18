import { HttpException } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';
import { pipeline, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { ProxyGuard } from '../guards/proxy.guard';
import { isModelPayloadRoute } from '../proxy.constants';

function limitError(): Error {
  return Object.assign(new Error('Request body is too large'), { statusCode: 413 });
}

function byteLimiter(limit: number) {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit) {
        done(limitError());
        return;
      }
      done(null, chunk);
    },
  });
  return { stream, bytes: () => bytes };
}

/** Decode only guarded JSON model routes and leave Fastify in charge of JSON parsing. */
export function registerGzipJsonIngress(instance: FastifyInstance): void {
  const guard = new ProxyGuard();
  instance.addHook('preParsing', (request, reply, payload, done) => {
    const encoding = request.headers['content-encoding']?.trim().toLowerCase();
    if (!encoding || encoding === 'identity') {
      done(null, payload);
      return;
    }
    const route = request.routeOptions.url;
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (
      request.method !== 'POST' ||
      !route ||
      !(isModelPayloadRoute(route) || route === '/v1/images/generations') ||
      contentType !== 'application/json'
    ) {
      done(null, payload);
      return;
    }
    try {
      guard.authorizeRequest(request);
    } catch (error) {
      if (!(error instanceof HttpException)) {
        throw error;
      }
      void reply.code(error.getStatus()).header('connection', 'close').send(error.getResponse());
      return;
    }
    if (encoding !== 'gzip') {
      done(Object.assign(new Error('Unsupported request content encoding'), { statusCode: 415 }));
      return;
    }
    const limit = request.routeOptions.bodyLimit;
    if (Number(request.headers['content-length']) > limit) {
      done(limitError());
      return;
    }

    const encoded = byteLimiter(limit);
    const decoded = byteLimiter(limit).stream;
    const gunzip = createGunzip();
    gunzip.prependListener('error', (error) => {
      if ('code' in error && typeof error.code === 'string' && error.code.startsWith('Z_')) {
        Object.assign(error, {
          message: 'Invalid gzip request body',
          code: 'invalid_gzip',
          statusCode: 400,
        });
      }
    });
    // Fastify compares Content-Length against compressed bytes for a preParsing stream.
    Object.defineProperty(decoded, 'receivedEncodedLength', { get: encoded.bytes });
    const abort = () => encoded.stream.destroy(new Error('Request body stream closed'));
    const stopOnEarlyReply = () => {
      if (!decoded.readableEnded) {
        abort();
      }
    };
    payload.once('error', abort);
    request.raw.once('aborted', abort);
    reply.raw.once('finish', stopOnEarlyReply);
    reply.raw.once('close', stopOnEarlyReply);
    pipeline(encoded.stream, gunzip, decoded, () => {
      payload.unpipe(encoded.stream);
      payload.removeListener('error', abort);
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('finish', stopOnEarlyReply);
      reply.raw.removeListener('close', stopOnEarlyReply);
    });
    done(null, decoded);
    payload.pipe(encoded.stream);
  });
}
