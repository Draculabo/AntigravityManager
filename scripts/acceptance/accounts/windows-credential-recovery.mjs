import assert from 'node:assert/strict';
import path from 'node:path';
import { z } from 'zod';

const Metadata = z.object({
  flags: z.number().int().nonnegative(),
  type: z.literal(1),
  targetName: z.string(),
  comment: z.string().nullable(),
  persist: z.number().int().min(1).max(3),
  attributeCount: z.literal(0),
  targetAlias: z.string().nullable(),
  username: z.string().nullable(),
  blobSize: z.number().int().min(0).max(5120),
  blob: z.bigint().nullable(),
});

function withApi(loadNative, action) {
  const koffi = loadNative('koffi');
  assert(process.env.SystemRoot && path.win32.isAbsolute(process.env.SystemRoot));
  const advapi = koffi.load(path.win32.join(process.env.SystemRoot, 'System32', 'Advapi32.dll'));
  const kernel = koffi.load(path.win32.join(process.env.SystemRoot, 'System32', 'Kernel32.dll'));
  try {
    const credential = koffi.struct({
      flags: 'uint32_t',
      type: 'uint32_t',
      targetName: 'str16',
      comment: 'str16',
      lastWritten: koffi.array('uint32_t', 2),
      blobSize: 'uint32_t',
      blob: 'void *',
      persist: 'uint32_t',
      attributeCount: 'uint32_t',
      attributes: 'void *',
      targetAlias: 'str16',
      username: 'str16',
    });
    return action({
      koffi,
      credential,
      advapi,
      getLastError: kernel.func('uint32_t __stdcall GetLastError()'),
    });
  } finally {
    kernel.unload();
    advapi.unload();
  }
}

function read(loadNative, target) {
  return withApi(loadNative, ({ koffi, credential, advapi, getLastError }) => {
    const output = [null];
    const readCredential = advapi.func(
      'int __stdcall CredReadW(str16 target, uint32_t type, uint32_t flags, _Out_ void **value)',
    );
    if (!readCredential(target, 1, 0, output)) {
      const code = getLastError();
      assert.equal(code, 1168, `Credential snapshot failed (${code})`);
      return null;
    }
    const pointer = z.bigint().parse(output[0]);
    const free = advapi.func('void __stdcall CredFree(void *value)');
    try {
      const parsed = Metadata.safeParse(koffi.decode(pointer, credential));
      assert(parsed.success, 'Unsupported credential metadata; refuse live mutation');
      const { blob, blobSize, ...metadata } = parsed.data;
      assert.equal(metadata.targetName, target);
      assert(blobSize === 0 || (blob !== null && blob !== 0n));
      const bytes = blobSize
        ? z
            .union([z.instanceof(Uint8Array), z.array(z.number().int().min(0).max(255))])
            .parse(koffi.decode(blob, 'uint8_t', blobSize))
        : [];
      return { metadata, bytes: Buffer.from(bytes) };
    } finally {
      free(pointer);
    }
  });
}

function equal(left, right) {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.bytes.equals(right.bytes) &&
    JSON.stringify(left.metadata) === JSON.stringify(right.metadata)
  );
}

/** Keep secret bytes in memory; preserve writable metadata and avoid writes when unchanged. */
export function captureWindowsCredential(loadNative, target) {
  const original = read(loadNative, target);
  let completed = false;
  return {
    restore() {
      if (completed) {
        return true;
      }
      const current = read(loadNative, target);
      const unchanged = equal(current, original);
      current?.bytes.fill(0);
      if (!unchanged) {
        withApi(loadNative, ({ koffi, credential, advapi, getLastError }) => {
          if (original === null) {
            const remove = advapi.func(
              'int __stdcall CredDeleteW(str16 target, uint32_t type, uint32_t flags)',
            );
            assert.equal(remove(target, 1, 0), 1, `Credential deletion failed (${getLastError()})`);
          } else {
            const write = advapi.func('__stdcall', 'CredWriteW', 'int', [
              koffi.pointer(credential),
              'uint32_t',
            ]);
            const result = write(
              {
                ...original.metadata,
                lastWritten: [0, 0],
                blobSize: original.bytes.length,
                blob: original.bytes,
                attributes: null,
              },
              0,
            );
            assert.equal(result, 1, `Credential restoration failed (${getLastError()})`);
          }
        });
      }
      const restored = read(loadNative, target);
      const matches = equal(restored, original);
      restored?.bytes.fill(0);
      assert(matches, 'Credential content or metadata was not restored');
      original?.bytes.fill(0);
      completed = true;
      return true;
    },
  };
}
