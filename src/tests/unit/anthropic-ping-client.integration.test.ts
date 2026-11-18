// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'd11-loopback-fixture',
}));

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

function frame(text: string, finish = false): string {
  return `data: ${JSON.stringify({
    response: {
      responseId: 'synthetic-d11-response',
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          ...(finish ? { finishReason: 'STOP' } : {}),
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17 },
    },
  })}\n\n`;
}

it.runIf(Boolean(process.env.AGM_D11_CLAUDE_EXE))(
  'serves an Anthropic ping and a complete answer to the installed Claude Code client',
  async () => {
    const executable = process.env.AGM_D11_CLAUDE_EXE;
    if (!executable) {
      throw new Error('Expected the installed Claude Code executable');
    }
    await using profile = await mkdtempDisposable(join(tmpdir(), 'agm-d11-claude-'));
    const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
    const first = new PassThrough();
    const second = new PassThrough();
    const upstream = createUpstream({ streamFrames: [] });
    upstream.streamGenerateInternal.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const lease = createLease([createAccount('d11-first'), createAccount('d11-second')]);
    const gateway = createGateway(upstream, lease);
    const key = 'synthetic-d11-client';
    const answer = 'D11 verified after heartbeat';
    let idleTicks = 0;
    const pingLog = vi.spyOn(Logger.prototype, 'debug').mockImplementation((message: unknown) => {
      if (typeof message !== 'string' || !message.startsWith('[Claude-SSE] SSE idle ping #')) {
        return;
      }
      idleTicks += 1;
      if (idleTicks === 1) {
        // Run after the same timer callback has offered the preflight ping.
        queueMicrotask(() => first.destroy(new Error('Synthetic preflight stream failure')));
      } else if (idleTicks === 2) {
        queueMicrotask(() => second.end(frame(answer, true)));
      }
    });
    second.write(frame('Fixture opening. '));

    @Module({
      controllers: [AnthropicController],
      providers: [ProxyGuard, { provide: AnthropicService, useValue: gateway.anthropicService }],
    })
    class ClaudePingModule {}

    let app: NestFastifyApplication | undefined;
    try {
      setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: key, request_timeout: 65 });
      const adapter = new FastifyAdapter();
      const writes: Array<() => unknown[]> = [];
      adapter.getInstance().addHook('onRequest', (request, reply, done) => {
        if (request.url.startsWith('/v1/messages') && request.method === 'POST') {
          const write = vi.spyOn(reply.raw, 'write');
          writes.push(() => write.mock.calls.map(([chunk]) => chunk));
        }
        done();
      });
      app = await NestFactory.create<NestFastifyApplication>(ClaudePingModule, adapter, {
        logger: false,
      });
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const { stdout } = await promisify(execFile)(
        executable,
        [
          '--print',
          '--output-format',
          'text',
          '--model',
          'claude-sonnet-4-5',
          '--no-session-persistence',
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--disable-slash-commands',
          '--tools',
          '',
          '--system-prompt',
          'Synthetic loopback acceptance test.',
          'Reply briefly.',
        ],
        {
          cwd: profile.path,
          windowsHide: true,
          timeout: 60_000,
          env: {
            Path: process.env.Path,
            SystemRoot: process.env.SystemRoot,
            TEMP: profile.path,
            TMP: profile.path,
            USERPROFILE: profile.path,
            HOME: profile.path,
            APPDATA: profile.path,
            LOCALAPPDATA: profile.path,
            CLAUDE_CONFIG_DIR: profile.path,
            ANTHROPIC_BASE_URL: origin,
            ANTHROPIC_API_KEY: key,
            HTTP_PROXY: origin,
            HTTPS_PROXY: origin,
            ALL_PROXY: origin,
            NO_PROXY: '127.0.0.1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
        },
      );
      expect(stdout).toContain(answer);
      expect(upstream.streamGenerateInternal).toHaveBeenCalledTimes(2);
      expect(writes).toHaveLength(1);
      const wire = writes.flatMap((read) => read()).join('');
      expect(wire.split('event: ping\ndata: {"type":"ping"}\n\n')).toHaveLength(2);
      expect(wire).toContain('event: message_stop');
      expect(wire).not.toContain('event: error');
      expect(idleTicks).toBe(2);
      expect(lease.markModelSuccess).toHaveBeenCalledOnce();
    } finally {
      first.destroy();
      second.destroy();
      try {
        await app?.close();
      } finally {
        pingLog.mockRestore();
        setServerConfig(previous);
      }
    }
  },
  70_000,
);
