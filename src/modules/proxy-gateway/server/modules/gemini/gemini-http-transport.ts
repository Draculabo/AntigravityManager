import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import type { ClientRequest } from 'node:http';
import { Readable } from 'node:stream';
import {
  GeminiTransportPool,
  GEMINI_TRANSPORT_LIMITS,
  withGeminiConnectionSignal,
} from './gemini-transport-pool';
import { throwIfRequestAborted } from '../../common/request-cancellation';
import { UpstreamTransportCapacityError } from '../../common/exceptions/upstream-transport-capacity.exception';

export class GeminiHttpTransport {
  private readonly pool: GeminiTransportPool;
  private closed = false;
  private readonly active = new Set<AbortController>();

  constructor(limits = GEMINI_TRANSPORT_LIMITS) {
    this.pool = new GeminiTransportPool(limits);
  }

  close(): void {
    this.closed = true;
    for (const controller of this.active) {
      controller.abort();
    }
    this.pool.close();
  }

  async post<T>(
    url: string,
    body: unknown,
    options: AxiosRequestConfig & {
      signal?: AbortSignal;
      streamTimeoutOwner?: 'generation' | 'transport';
    },
    onAdmitted?: () => void,
    observeRequest?: (request: ClientRequest) => void,
  ): Promise<AxiosResponse<T>> {
    throwIfRequestAborted(options.signal);
    const lease = this.pool.acquire(url, options.proxy);
    const deadline = new AbortController();
    this.active.add(deadline);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const timer =
      options.streamTimeoutOwner !== 'generation' && options.timeout && options.timeout > 0
        ? setTimeout(() => deadline.abort(), options.timeout)
        : undefined;
    timer?.unref();
    let responseBody: unknown;
    try {
      onAdmitted?.();
      const { streamTimeoutOwner, ...requestOptions } = options;
      const response = await withGeminiConnectionSignal({ signal, observeRequest }, () =>
        axios.post<T>(url, body, {
          ...requestOptions,
          // The owned timer bounds headers; body silence belongs to the generation phase owner.
          ...(streamTimeoutOwner ? { timeout: 0 } : {}),
          proxy: false,
          signal,
          httpAgent: lease.httpAgent,
          httpsAgent: lease.httpsAgent,
        }),
      );
      responseBody = response.data;
      if (signal.aborted && responseBody instanceof Readable) {
        responseBody.destroy();
      }
      throwIfRequestAborted(signal);
      return response;
    } catch (error) {
      if (this.closed) {
        throw new UpstreamTransportCapacityError();
      }
      if (deadline.signal.aborted && !options.signal?.aborted) {
        throw new AxiosError('Upstream request timed out', AxiosError.ETIMEDOUT);
      }
      if (axios.isAxiosError(error)) {
        responseBody = error.response?.data;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (
        responseBody instanceof Readable &&
        !responseBody.destroyed &&
        !responseBody.readableEnded
      ) {
        const stream = responseBody;
        const release = () => {
          stream.removeListener('close', release);
          stream.removeListener('end', release);
          lease.release();
          this.active.delete(deadline);
        };
        stream.once('close', release);
        stream.once('end', release);
      } else {
        lease.release();
        this.active.delete(deadline);
      }
    }
  }
}
