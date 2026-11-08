import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createErrorDesktopService } from '@/modules/error-diagnostics/error-desktop.service';
import { createDiagnosticErrorRecord } from '@/shared/observability/errorDiagnostic';
import { encodeErrorRecord, decodeErrorRecord } from '@/modules/error-diagnostics/error-record';
import { DiagnosticContentCapabilities } from '@/shared/observability/content-capability';
import type { ErrorDiagnosticOperations } from '@/modules/error-diagnostics/error-owner.service';

function fixture() {
  let generation = randomUUID();
  let now = 100;
  const content = new DiagnosticContentCapabilities();
  const error = new Error('complete diagnostic');
  error.stack = 'Error: complete diagnostic\n' + '    at 帧😀 (file.ts:1:2)\n'.repeat(10_000);
  const record = createDiagnosticErrorRecord({
    error,
    role: 'core',
    source: 'test',
    category: 'fixture',
  });
  const encoded = encodeErrorRecord(record);
  if (!encoded.accepted) {
    throw new Error('Expected complete fixture');
  }
  const source: ErrorDiagnosticOperations = {
    status: async () => {
      throw new Error('unused');
    },
    query: async () => ({
      generation,
      records: [],
      throughSequence: 0,
      nextSequence: null,
      complete: true,
    }),
    open: async () => ({
      metadata: {
        id: record.id,
        createdAt: record.createdAt,
        source: 'test',
        category: 'fixture',
        requestId: null,
        attemptId: null,
        status: null,
        message: record.message,
        bytes: encoded.bytes,
      },
      transfer: {
        ...content.open('error', `${generation}/${record.id}`, [Buffer.from(encoded.body)]),
        kind: 'error' as const,
      },
    }),
    readContent: async (input) => content.read(input),
    closeContent: async (input) => {
      content.release(input);
      return { closed: true };
    },
    clear: async () => {
      generation = randomUUID();
      content.invalidate('error');
      return { generation, records: 1 };
    },
  };
  const choose = vi.fn<() => Promise<string | null>>().mockResolvedValue('outside-profile.txt');
  const write = vi
    .fn<(_path: string, body: string, guard: () => void) => Promise<void>>()
    .mockImplementation(async (_path, _body, guard) => guard());
  const service = createErrorDesktopService({
    source: () => source,
    now: () => now,
    choose,
    write,
  });
  return {
    service,
    source,
    record,
    encoded,
    content,
    choose,
    write,
    advance: () => {
      now += 10 * 60 * 1000;
    },
  };
}

it('marks a bounded UTF-8 preview but saves the complete sanitized record', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare('core', f.record.id);
    expect(prepared.status).toBe('ready');
    if (prepared.status !== 'ready') {
      throw new Error('Expected preview');
    }
    expect(prepared.preview.truncated).toBe(true);
    expect(Buffer.byteLength(prepared.preview.text)).toBeLessThanOrEqual(64 * 1024);
    expect(prepared.preview.text).not.toContain('\uFFFD');
    expect(prepared.preview).not.toHaveProperty('body');
    expect(await f.service.save(prepared.preview.capabilityId)).toEqual({ status: 'saved' });
    expect(f.write).toHaveBeenCalledOnce();
    expect(decodeErrorRecord(f.write.mock.calls[0][1].trimEnd())).toEqual(
      decodeErrorRecord(f.encoded.body),
    );
  } finally {
    f.content.close();
  }
});

it('preserves cancelled previews, expires capabilities and never accepts renderer file contents', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare('core', f.record.id);
    if (prepared.status !== 'ready') {
      throw new Error('Expected preview');
    }
    f.choose.mockResolvedValueOnce(null);
    expect(await f.service.save(prepared.preview.capabilityId)).toEqual({ status: 'cancelled' });
    expect(f.write).not.toHaveBeenCalled();
    f.advance();
    expect(await f.service.save(prepared.preview.capabilityId)).toEqual({ status: 'expired' });
    expect(await f.service.save(randomUUID())).toEqual({ status: 'expired' });
  } finally {
    f.content.close();
  }
});

it('revokes local previews and an in-flight save before atomic replacement when the source is cleared', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare('core', f.record.id);
    if (prepared.status !== 'ready') {
      throw new Error('Expected preview');
    }
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.write.mockImplementationOnce(async (_path, _body, guard) => {
      started();
      await gate;
      guard();
    });
    const saving = f.service.save(prepared.preview.capabilityId);
    await ready;
    await f.service.clear('core');
    release();
    expect(await saving).toEqual({ status: 'failed' });
    expect(await f.service.save(prepared.preview.capabilityId)).toEqual({ status: 'expired' });
  } finally {
    f.content.close();
  }
});

it('detects remote clear before export without saving an invalidated snapshot', async () => {
  const f = fixture();
  try {
    const prepared = await f.service.prepare('core', f.record.id);
    if (prepared.status !== 'ready') {
      throw new Error('Expected preview');
    }
    await f.source.clear();
    expect(await f.service.save(prepared.preview.capabilityId)).toEqual({ status: 'expired' });
    expect(f.write).not.toHaveBeenCalled();
  } finally {
    f.content.close();
  }
});

it('caps retained previews and treats failed writes as failures rather than saved exports', async () => {
  const f = fixture();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const prepared = await f.service.prepare('core', f.record.id);
      if (prepared.status !== 'ready') {
        throw new Error('Expected preview');
      }
      ids.push(prepared.preview.capabilityId);
    }
    expect(await f.service.save(ids[0])).toEqual({ status: 'expired' });
    f.write.mockRejectedValueOnce(new Error('fixture destination refusal'));
    expect(await f.service.save(ids[4])).toEqual({ status: 'failed' });
  } finally {
    f.content.close();
  }
});
