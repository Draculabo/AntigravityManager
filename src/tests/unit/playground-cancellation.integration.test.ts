// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/message-port';
import { RPCHandler } from '@orpc/server/message-port';
import type { RouterClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createPlaygroundRouter } from '@/modules/proxy-gateway/playground/playground.router';
import { PlaygroundService } from '@/modules/proxy-gateway/playground/playground.service';
import * as serverMain from '@/server/main';

describe('Playground MessagePort cancellation', () => {
  it('cancels the owner HTTP request through the actual renderer transport', async () => {
    const { port1, port2 } = new MessageChannel();
    const controller = new AbortController();
    vi.spyOn(serverMain, 'getNestServerStatus').mockResolvedValue({
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 1,
    });
    let signalStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => {
      signalStarted = resolve;
    });
    let httpFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      httpFinished = resolve;
    });
    vi.spyOn(axios, 'post').mockImplementation((_url, _body, config) => {
      const signal = config?.signal as AbortSignal;
      signalStarted(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new axios.CanceledError());
            httpFinished();
          },
          { once: true },
        );
      });
    });
    const router = createPlaygroundRouter(new PlaygroundService());
    new RPCHandler(router).upgrade(port2);
    port1.start();
    port2.start();
    const client = createORPCClient<RouterClient<typeof router>>(new RPCLink({ port: port1 }));
    try {
      const pending = client.execute(
        { model: 'gemini-3-flash', prompt: 'Hi' },
        { signal: controller.signal },
      );
      const handled = pending.catch(() => undefined);
      const ownerSignal = await started;
      controller.abort();
      await Promise.all([handled, finished]);
      expect(ownerSignal.aborted).toBe(true);
    } finally {
      controller.abort();
      port1.close();
      port2.close();
      vi.restoreAllMocks();
    }
  });
});
