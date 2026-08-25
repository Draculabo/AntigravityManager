import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 9),
]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16, 4)]);

function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function sent(reply: Record<string, unknown>): unknown {
  return (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

function statusOf(reply: Record<string, unknown>): unknown {
  return (reply.status as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

describe('file handles become inline content on the way upstream', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) {
      // Windows keeps a handle for a moment after the last write resolves.
      rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
    }
    roots.length = 0;
  });

  function createStore() {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'agm-expand-'));
    roots.push(rootDirectory);
    return new FileContentStore({ rootDirectory, sweepIntervalMs: 0 });
  }

  async function storeFile(store: FileContentStore, bytes: Buffer, displayName: string) {
    const record = await store.put({ bytes, displayName });
    return record.id;
  }

  function createFiles(store: FileContentStore) {
    return new FilesService(store);
  }

  it('resolves an OpenAI chat file part into the image the mapper understands', async () => {
    const store = createStore();
    const id = await storeFile(store, png, 'shot.png');
    const handleChatCompletions = vi.fn().mockResolvedValue({ id: 'chatcmpl_1', choices: [] });
    const controller = new OpenAIController(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      createFiles(store),
    );

    await controller.chatCompletions(
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', file: { file_id: `file-${id}` } }] as never,
          },
        ],
      },
      createReplyMock() as never,
    );

    const forwarded = JSON.stringify(handleChatCompletions.mock.calls[0][0]);
    expect(forwarded).toContain('data:image/png;base64,');
    expect(forwarded).not.toContain('file_id');
  });

  it('resolves an Anthropic document source into the inline block the transport takes', async () => {
    const store = createStore();
    const id = await storeFile(store, pdf, 'contract.pdf');
    const handleAnthropicMessages = vi.fn().mockResolvedValue({ id: 'msg_1', content: [] });
    const controller = new AnthropicController(
      { handleAnthropicMessages } as never,
      createFiles(store),
    );

    await controller.anthropicMessages(
      {
        model: 'claude-sonnet-4',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'file', file_id: `file_${id}` } },
            ] as never,
          },
        ],
      },
      createReplyMock() as never,
    );

    const forwarded = handleAnthropicMessages.mock.calls[0][0];
    expect(forwarded.messages[0].content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
    });
  });

  it('resolves a Gemini fileData part into inlineData', async () => {
    const store = createStore();
    const id = await storeFile(store, png, 'shot.png');
    const handleGeminiGenerateContent = vi.fn().mockResolvedValue({ candidates: [] });
    const controller = new GeminiController(
      { handleGeminiGenerateContent } as never,
      undefined,
      createFiles(store),
    );

    await controller.modelAction(
      'gemini-3-flash:generateContent',
      {
        contents: [
          {
            role: 'user',
            parts: [{ fileData: { fileUri: `files/${id}`, mimeType: 'image/png' } }] as never,
          },
        ],
      },
      createReplyMock() as never,
    );

    const forwarded = handleGeminiGenerateContent.mock.calls[0][1];
    expect(forwarded.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: png.toString('base64') },
    });
  });

  it('refuses a handle it never issued instead of forwarding it upstream', async () => {
    const store = createStore();
    const handleChatCompletions = vi.fn();
    const controller = new OpenAIController(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      createFiles(store),
    );
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', file: { file_id: 'file-deadbeef' } }] as never,
          },
        ],
      },
      reply as never,
    );

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(statusOf(reply)).toBe(404);
    expect(sent(reply)).toMatchObject({
      error: { code: 'file_not_found', type: 'invalid_request_error' },
    });
  });

  it('answers an unresolvable handle in the caller’s own dialect', async () => {
    const store = createStore();
    const geminiReply = createReplyMock();
    const anthropicReply = createReplyMock();
    const gemini = new GeminiController(
      { handleGeminiGenerateContent: vi.fn() } as never,
      undefined,
      createFiles(store),
    );
    const anthropic = new AnthropicController(
      { handleAnthropicMessages: vi.fn() } as never,
      createFiles(store),
    );

    await gemini.modelAction(
      'gemini-3-flash:generateContent',
      { contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'files/nope' } }] as never }] },
      geminiReply as never,
    );
    await anthropic.anthropicMessages(
      {
        model: 'claude-sonnet-4',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'file', file_id: 'file_nope' } }] as never,
          },
        ],
      },
      anthropicReply as never,
    );

    expect(statusOf(geminiReply)).toBe(404);
    expect(sent(geminiReply)).toMatchObject({ error: { status: 'NOT_FOUND' } });
    expect(statusOf(anthropicReply)).toBe(404);
    expect(sent(anthropicReply)).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
  });

  it('refuses an expired handle rather than sending an empty part', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'agm-expand-'));
    roots.push(rootDirectory);
    const store = new FileContentStore({ rootDirectory, sweepIntervalMs: 0, ttlMs: 1 });
    const id = await storeFile(store, png, 'brief.png');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const handleChatCompletions = vi.fn();
    const controller = new OpenAIController(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      createFiles(store),
    );
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: id } }] as never }],
      },
      reply as never,
    );

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(statusOf(reply)).toBe(404);
    expect(JSON.stringify(sent(reply))).toContain('expired');
  });

  it('fails closed when no file store is wired at all', async () => {
    const handleChatCompletions = vi.fn();
    const controller = new OpenAIController({ handleChatCompletions } as never);
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [{ type: 'file', file: { file_id: 'file-deadbeef' } }] as never,
          },
        ],
      },
      reply as never,
    );

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(statusOf(reply)).toBe(404);
    expect(JSON.stringify(sent(reply))).toContain('file store is not available');
  });

  it('leaves a request that names no handle exactly as it arrived', async () => {
    const store = createStore();
    const handleChatCompletions = vi.fn().mockResolvedValue({ id: 'chatcmpl_1', choices: [] });
    const controller = new OpenAIController(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      createFiles(store),
    );
    const body = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'plain text' }],
    };

    await controller.chatCompletions(body as never, createReplyMock() as never);

    expect(handleChatCompletions.mock.calls[0][0]).toBe(body);
  });
});
