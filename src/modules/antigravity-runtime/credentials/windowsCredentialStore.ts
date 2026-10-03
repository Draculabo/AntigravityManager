import path from 'node:path';
import type { KoffiFunc } from 'koffi';
import { z } from 'zod';

/** Uses the exact Win32 target; keytar joins service/account with a slash. */
export async function readWindowsCredential(target: string): Promise<string | null> {
  return withCredentialApi(({ koffi, credential, advapi, getLastError }) => {
    const read = advapi.func(
      'int __stdcall CredReadW(str16 target, uint32_t type, uint32_t flags, _Out_ void **value)',
    ) as KoffiFunc<
      (target: string, type: number, flags: number, value: (bigint | null)[]) => number
    >;
    const free = advapi.func('void __stdcall CredFree(void *value)') as KoffiFunc<
      (value: bigint) => void
    >;
    const output: (bigint | null)[] = [null];
    // Keep the call and GetLastError on the same thread. These local vault operations
    // do not start a subprocess or create an entry as a side effect of reading.
    if (!read(target, 1, 0, output)) {
      const code = getLastError();
      if (code === 1168) {
        return null;
      }
      if (code === 5) {
        throw new Error('Windows credential access denied (5)');
      }
      throw new Error(`Windows credential read failed (${code})`);
    }
    const pointer = output[0];
    if (typeof pointer !== 'bigint' || pointer === 0n) {
      throw new Error('Windows credential read returned no allocation');
    }
    try {
      const decoded: unknown = koffi.decode(pointer, credential);
      const result = z
        .object({
          targetName: z.literal(target),
          blobSize: z.number().int().min(0).max(5120),
          blob: z.bigint().nullable(),
        })
        .safeParse(decoded);
      if (!result.success) {
        throw new Error('Windows credential metadata is invalid');
      }
      if (result.data.blobSize === 0) {
        return '';
      }
      if (result.data.blob === null || result.data.blob === 0n) {
        throw new Error('Windows credential has no payload allocation');
      }
      const bytes: unknown = koffi.decode(result.data.blob, 'uint8_t', result.data.blobSize);
      const parsed = z
        .union([z.instanceof(Uint8Array), z.array(z.number().int().min(0).max(255))])
        .safeParse(bytes);
      if (!parsed.success) {
        throw new Error('Windows credential payload is invalid');
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(parsed.data));
    } finally {
      free(pointer);
    }
  });
}

export async function writeWindowsCredential(
  target: string,
  username: string,
  payload: string,
): Promise<void> {
  await withCredentialApi(({ koffi, credential, advapi, getLastError }) => {
    const write = advapi.func('__stdcall', 'CredWriteW', 'int', [
      koffi.pointer(credential),
      'uint32_t',
    ]);
    const blob = Buffer.from(payload, 'utf8');
    try {
      const success: unknown = write(
        {
          flags: 0,
          type: 1,
          targetName: target,
          comment: null,
          lastWritten: [0, 0],
          blobSize: blob.length,
          blob,
          persist: 2,
          attributeCount: 0,
          attributes: null,
          targetAlias: null,
          username,
        },
        0,
      );
      if (success !== 1) {
        throw new Error(`Windows credential write failed (${getLastError()})`);
      }
    } finally {
      blob.fill(0);
    }
  });
}

async function withCredentialApi<T>(
  operation: (api: {
    koffi: typeof import('koffi');
    credential: import('koffi').TypeObject;
    advapi: ReturnType<typeof import('koffi').load>;
    getLastError: KoffiFunc<() => number>;
  }) => T,
): Promise<T> {
  const koffi = await import('koffi');
  const root = process.env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) {
    throw new Error('Windows system directory is unavailable');
  }
  const advapi = koffi.load(path.win32.join(root, 'System32', 'Advapi32.dll'));
  const kernel = koffi.load(path.win32.join(root, 'System32', 'Kernel32.dll'));
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
    const getLastError = kernel.func('uint32_t __stdcall GetLastError()') as KoffiFunc<
      () => number
    >;
    return operation({ koffi, credential, advapi, getLastError });
  } finally {
    kernel.unload();
    advapi.unload();
  }
}
