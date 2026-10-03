import path from 'node:path';
import type { KoffiFunc } from 'koffi';
import { z } from 'zod';

const FixedFileInfoSchema = z.object({
  signature: z.literal(0xfeef04bd),
  fileVersionMS: z.number().int().nonnegative(),
  fileVersionLS: z.number().int().nonnegative(),
});

/** Reads the PE version resource without starting a shell or the application. */
export async function readWindowsFileVersion(executablePath: string): Promise<string> {
  const koffi = await import('koffi');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error('Windows system directory is unavailable');
  }
  const library = koffi.load(path.win32.join(systemRoot, 'System32', 'version.dll'));
  try {
    const getSize = library.func(
      'uint32_t __stdcall GetFileVersionInfoSizeW(str16 filename, _Out_ uint32_t *handle)',
    ) as KoffiFunc<(filename: string, handle: number[]) => number>;
    const getInfo = library.func(
      'int __stdcall GetFileVersionInfoW(str16 filename, uint32_t handle, uint32_t length, void *data)',
    ) as KoffiFunc<(filename: string, handle: number, length: number, data: Buffer) => number>;
    const queryInfo = library.func(
      'int __stdcall VerQueryValueW(void *data, str16 block, _Out_ void **value, _Out_ uint32_t *length)',
    ) as KoffiFunc<
      (data: Buffer, block: string, value: (bigint | null)[], length: number[]) => number
    >;
    const length = await new Promise<number>((resolve, reject) => {
      getSize.async(executablePath, [0], (error: unknown, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
    if (!Number.isInteger(length) || length <= 0 || length > 16 * 1024 * 1024) {
      throw new Error('Executable version resource is missing or invalid');
    }
    // The buffers and library remain owned until every native callback completes,
    // including when the caller's separate deadline has already expired.
    const data = Buffer.alloc(length);
    const loaded = await new Promise<number>((resolve, reject) => {
      getInfo.async(executablePath, 0, length, data, (error: unknown, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
    if (!loaded) {
      throw new Error('Unable to read executable version resource');
    }
    const value: (bigint | null)[] = [null];
    const size = [0];
    const found = await new Promise<number>((resolve, reject) => {
      queryInfo.async(data, '\\', value, size, (error: unknown, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
    if (!found || typeof value[0] !== 'bigint' || size[0] < 52) {
      throw new Error('Executable fixed version information is invalid');
    }
    const fixedInfo: unknown = {
      signature: koffi.decode(value[0], 0, 'uint32_t'),
      fileVersionMS: koffi.decode(value[0], 8, 'uint32_t'),
      fileVersionLS: koffi.decode(value[0], 12, 'uint32_t'),
    };
    const info = FixedFileInfoSchema.parse(fixedInfo);
    const parts = [
      info.fileVersionMS >>> 16,
      info.fileVersionMS & 0xffff,
      info.fileVersionLS >>> 16,
      info.fileVersionLS & 0xffff,
    ];
    if (parts[3] === 0) {
      parts.pop();
    }
    return parts.join('.');
  } finally {
    library.unload();
  }
}
