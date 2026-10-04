import { describe, expect, it, vi } from 'vitest';
import { DiagnosticContentCapabilities } from '@/modules/proxy-gateway/diagnostics/content-capability';
import {
  DIAGNOSTIC_CHUNK_BYTES,
  DIAGNOSTIC_CONTENT_TTL_MS,
  DIAGNOSTIC_RETAINED_BYTES,
  type ContentIdentity,
} from '@/modules/proxy-gateway/diagnostics/content-capability.schema';
import { readDiagnosticContent } from '@/modules/proxy-gateway/diagnostics/read-content';

function identity(value: ContentIdentity): ContentIdentity {
  return {
    epoch: value.epoch,
    capabilityId: value.capabilityId,
    kind: value.kind,
    resourceId: value.resourceId,
  };
}
describe('diagnostic content capabilities', () => {
  it('binds sequential chunks to owner epoch, purpose and resource and releases on completion', () => {
    const content = new DiagnosticContentCapabilities();
    const bytes = Buffer.from('🙂正文'.repeat(20000));
    const descriptor = content.open('thought', 'session/1', [
      bytes.subarray(0, 3),
      bytes.subarray(3),
    ]);
    const key = identity(descriptor);
    expect(() => content.read({ ...key, kind: 'curl', cursor: 0 })).toThrow(
      'Diagnostic content is unavailable.',
    );
    expect(() => content.read({ ...key, resourceId: 'session/2', cursor: 0 })).toThrow(
      'Diagnostic content is unavailable.',
    );
    const other = new DiagnosticContentCapabilities();
    expect(() => other.read({ ...key, cursor: 0 })).toThrow('Diagnostic content is unavailable.');
    let cursor = 0;
    const result: Buffer[] = [];
    while (cursor < bytes.length) {
      const chunk = content.read({ ...key, cursor });
      result.push(Buffer.from(chunk.data, 'base64'));
      expect(chunk.nextCursor - chunk.cursor).toBeLessThanOrEqual(DIAGNOSTIC_CHUNK_BYTES);
      if (cursor === 0) {
        expect(() => content.read({ ...key, cursor: 0 })).toThrow(
          'Diagnostic content is unavailable.',
        );
      }
      cursor = chunk.nextCursor;
    }
    expect(Buffer.concat(result)).toEqual(bytes);
    expect(() => content.read({ ...key, cursor })).toThrow('Diagnostic content is unavailable.');
    content.release(key);
    content.close();
    other.close();
  });

  it('expires capabilities, bounds slots and invalidates snapshots on shutdown', () => {
    let now = 10;
    const content = new DiagnosticContentCapabilities(() => now);
    const descriptors = Array.from({ length: 4 }, (_, index) =>
      content.open('thought', `session/${index}`, [Buffer.from('body')]),
    );
    expect(() => content.open('thought', 'session/5', [])).toThrow(
      'Diagnostic content is unavailable.',
    );
    now += DIAGNOSTIC_CONTENT_TTL_MS;
    expect(() => content.read({ ...identity(descriptors[0]), cursor: 0 })).toThrow(
      'Diagnostic content is unavailable.',
    );
    const next = content.open('thought', 'session/5', []);
    content.close();
    expect(() => content.read({ ...identity(next), cursor: 0 })).toThrow(
      'Diagnostic content is unavailable.',
    );
    expect(() => content.open('thought', 'session/6', [])).toThrow(
      'Diagnostic content is unavailable.',
    );
  });

  it('enforces the aggregate retained-byte budget and returns capacity on release', () => {
    const content = new DiagnosticContentCapabilities();
    const part = Buffer.alloc(DIAGNOSTIC_RETAINED_BYTES / 4);
    const descriptor = content.open('thought', 'session/1', [part, part, part, part]);
    expect(() => content.open('thought', 'session/2', [Buffer.from('x')])).toThrow(
      'Diagnostic content is unavailable.',
    );
    content.release(identity(descriptor));
    expect(content.open('thought', 'session/2', [Buffer.from('x')]).totalBytes).toBe(1);
    content.close();
  });

  it('rejects a malformed chunk and requests cleanup instead of assembling partial data', async () => {
    const content = new DiagnosticContentCapabilities();
    const descriptor = content.open('thought', 'session/1', [Buffer.from('body')]);
    const closeContent = vi.fn(async (key: ContentIdentity) => {
      content.release(key);
      return { closed: true as const };
    });
    await expect(
      readDiagnosticContent(
        {
          readContent: async () => ({ cursor: 0, nextCursor: 4, complete: true, data: 'YQ==' }),
          closeContent,
        },
        descriptor,
      ),
    ).rejects.toThrow('Diagnostic content is unavailable.');
    expect(closeContent).toHaveBeenCalledWith(identity(descriptor));
    expect(() => content.read({ ...identity(descriptor), cursor: 0 })).toThrow(
      'Diagnostic content is unavailable.',
    );
    content.close();
  });
});
