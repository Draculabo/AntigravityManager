import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  AgyBinaryPatchError,
  patchAgyBinaryBuffer,
} from '@/modules/antigravity-runtime/binary-patch/agyBinaryPatchCore';
import { patchAgyBinaryFile } from '@/modules/antigravity-runtime/binary-patch/agyBinaryPatchService';

const X86_PATTERN = Buffer.from([
  0x41, 0x80, 0x3c, 0x24, 0x00, 0x0f, 0x85, 0x11, 0x22, 0x33, 0x44, 0x48, 0x8d, 0x05, 0x55, 0x66,
  0x77, 0x88, 0xbb, 0x18,
]);

function createPeX64Binary(patternOffsets: number[]): Buffer {
  const binary = Buffer.alloc(0x300);
  binary.write('MZ', 0, 'ascii');
  binary.writeUInt32LE(0x80, 0x3c);
  binary.write('PE\0\0', 0x80, 'binary');
  binary.writeUInt16LE(0x8664, 0x84);

  for (const offset of patternOffsets) {
    X86_PATTERN.copy(binary, offset);
  }

  return binary;
}

function createMachOArm64Binary(): Buffer {
  const binary = Buffer.alloc(0x100);
  binary.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  binary.writeUInt32LE(0x0100000c, 4);

  const patternOffset = 0x40;
  const sourceRegister = 2;
  const flagRegister = 1;
  const targetRegister = 3;
  binary.writeUInt32LE((0x39416000 | (sourceRegister << 5) | flagRegister) >>> 0, patternOffset);
  binary.writeUInt32LE((0x37000000 | (4 << 5) | flagRegister) >>> 0, patternOffset + 4);
  binary.writeUInt32LE(0xd503201f, patternOffset + 8);
  binary.writeUInt32LE(
    (0xf9401c00 | (sourceRegister << 5) | targetRegister) >>> 0,
    patternOffset + 12,
  );
  binary.writeUInt32LE((0xb4000000 | (4 << 5) | targetRegister) >>> 0, patternOffset + 16);

  return binary;
}

function createUniversalMachOBinary(): Buffer {
  const x86Slice = Buffer.alloc(0x100);
  x86Slice.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  x86Slice.writeUInt32LE(0x01000007, 4);
  X86_PATTERN.copy(x86Slice, 0x40);

  const arm64Slice = createMachOArm64Binary();
  const binary = Buffer.alloc(0x300);
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(2, 4);

  binary.writeUInt32BE(0x01000007, 8);
  binary.writeUInt32BE(3, 12);
  binary.writeUInt32BE(0x100, 16);
  binary.writeUInt32BE(x86Slice.length, 20);
  binary.writeUInt32BE(0, 24);

  binary.writeUInt32BE(0x0100000c, 28);
  binary.writeUInt32BE(0, 32);
  binary.writeUInt32BE(0x200, 36);
  binary.writeUInt32BE(arm64Slice.length, 40);
  binary.writeUInt32BE(0, 44);

  x86Slice.copy(binary, 0x100);
  arm64Slice.copy(binary, 0x200);
  return binary;
}

describe('agy binary patch core', () => {
  it('patches the unique x86_64 eligibility branch in a PE executable', () => {
    const source = createPeX64Binary([0x100]);

    const result = patchAgyBinaryBuffer(source);

    expect(result.analysis).toEqual({
      architectures: ['x86_64'],
      format: 'pe',
      patchedOffsets: [0x105],
      status: 'patched',
    });
    expect(Array.from(result.buffer.subarray(0x105, 0x10b))).toEqual([
      0x90, 0x90, 0x90, 0x90, 0x90, 0x90,
    ]);
    expect(Array.from(source.subarray(0x105, 0x10b))).toEqual([0x0f, 0x85, 0x11, 0x22, 0x33, 0x44]);
  });

  it('patches the ARM64 cbz instruction in a Mach-O executable', () => {
    const source = createMachOArm64Binary();

    const result = patchAgyBinaryBuffer(source);

    expect(result.analysis).toEqual({
      architectures: ['arm64'],
      format: 'mach-o',
      patchedOffsets: [0x50],
      status: 'patched',
    });
    expect(result.buffer.readUInt32LE(0x50)).toBe(0x14000004);
  });

  it('preserves a negative ARM64 branch displacement when converting cbz to b', () => {
    const source = createMachOArm64Binary();
    source.writeUInt32LE((0xb4000000 | (0x7fffc << 5) | 3) >>> 0, 0x50);

    const result = patchAgyBinaryBuffer(source);

    expect(result.analysis).toEqual({
      architectures: ['arm64'],
      format: 'mach-o',
      patchedOffsets: [0x50],
      status: 'patched',
    });
    expect(result.buffer.readUInt32LE(0x50)).toBe(0x17fffffc);
  });

  it('reports an already patched ARM64 executable without changing it', () => {
    const source = createMachOArm64Binary();
    source.writeUInt32LE(0x14000004, 0x50);

    const result = patchAgyBinaryBuffer(source);

    expect(result.analysis).toEqual({
      architectures: ['arm64'],
      format: 'mach-o',
      patchedOffsets: [0x50],
      status: 'already-patched',
    });
    expect(result.buffer.equals(source)).toBe(true);
  });

  it('patches both architecture slices in a universal Mach-O executable', () => {
    const result = patchAgyBinaryBuffer(createUniversalMachOBinary());

    expect(result.analysis).toEqual({
      architectures: ['x86_64', 'arm64'],
      format: 'mach-o-universal',
      patchedOffsets: [0x145, 0x250],
      status: 'patched',
    });
    expect(Array.from(result.buffer.subarray(0x145, 0x14b))).toEqual([
      0x90, 0x90, 0x90, 0x90, 0x90, 0x90,
    ]);
    expect(result.buffer.readUInt32LE(0x250)).toBe(0x14000004);
  });

  it('reports an already patched x86_64 executable without changing it', () => {
    const source = createPeX64Binary([0x100]);
    source.fill(0x90, 0x105, 0x10b);

    const result = patchAgyBinaryBuffer(source);

    expect(result.analysis).toEqual({
      architectures: ['x86_64'],
      format: 'pe',
      patchedOffsets: [0x105],
      status: 'already-patched',
    });
    expect(result.buffer.equals(source)).toBe(true);
  });

  it('rejects an ambiguous executable instead of patching the first match', () => {
    const source = createPeX64Binary([0x100, 0x180]);

    expect(() => patchAgyBinaryBuffer(source)).toThrowError(
      new AgyBinaryPatchError(
        'AMBIGUOUS_PATTERN',
        'Found 2 x86_64 eligibility patterns; expected exactly one.',
      ),
    );
  });

  it('rejects unknown binary formats', () => {
    expect(() => patchAgyBinaryBuffer(Buffer.alloc(128))).toThrowError(
      new AgyBinaryPatchError(
        'UNSUPPORTED_BINARY',
        'The selected file is not a supported PE, Mach-O, or ELF executable.',
      ),
    );
  });
});

describe('agy binary patch service', () => {
  it('backs up, patches, and verifies an agy executable', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-patch-'));
    const executablePath = path.join(tempDirectory, 'agy.exe');
    const source = createPeX64Binary([0x100]);
    fs.writeFileSync(executablePath, source);
    const realExecutablePath = await fs.promises.realpath(executablePath);
    const backupPath = `${realExecutablePath}.bak`;

    try {
      const result = await patchAgyBinaryFile(executablePath);

      expect(result).toEqual({
        architectures: ['x86_64'],
        backupPath,
        filePath: realExecutablePath,
        format: 'pe',
        patchedOffsets: [0x105],
        status: 'patched',
      });
      expect(fs.readFileSync(backupPath).equals(source)).toBe(true);
      expect(Array.from(fs.readFileSync(executablePath).subarray(0x105, 0x10b))).toEqual([
        0x90, 0x90, 0x90, 0x90, 0x90, 0x90,
      ]);
    } finally {
      fs.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it('does not rewrite or create another backup for an already patched executable', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-patch-'));
    const executablePath = path.join(tempDirectory, 'agy.exe');
    const source = createPeX64Binary([0x100]);
    source.fill(0x90, 0x105, 0x10b);
    fs.writeFileSync(executablePath, source);
    const realExecutablePath = await fs.promises.realpath(executablePath);

    try {
      const result = await patchAgyBinaryFile(executablePath);

      expect(result).toEqual({
        architectures: ['x86_64'],
        backupPath: null,
        filePath: realExecutablePath,
        format: 'pe',
        patchedOffsets: [0x105],
        status: 'already-patched',
      });
      expect(fs.existsSync(`${executablePath}.bak`)).toBe(false);
      expect(fs.readFileSync(executablePath).equals(source)).toBe(true);
    } finally {
      fs.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it('restores the original Mach-O file when codesigning fails', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-patch-'));
    const executablePath = path.join(tempDirectory, 'agy');
    const source = createMachOArm64Binary();
    fs.writeFileSync(executablePath, source);

    try {
      await expect(
        patchAgyBinaryFile(executablePath, {
          platform: 'darwin',
          signBinary: async () => {
            throw new Error('codesign rejected the binary');
          },
        }),
      ).rejects.toThrow('Patch rolled back because macOS codesigning failed');
      expect(fs.readFileSync(executablePath).equals(source)).toBe(true);
      expect(fs.readFileSync(`${executablePath}.bak`).equals(source)).toBe(true);
    } finally {
      fs.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });

  it('rejects files that are not named agy or agy.exe', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-patch-'));
    const executablePath = path.join(tempDirectory, 'Antigravity.exe');
    fs.writeFileSync(executablePath, createPeX64Binary([0x100]));

    try {
      await expect(patchAgyBinaryFile(executablePath)).rejects.toThrow(
        'Only the agy or agy.exe CLI executable can be patched.',
      );
    } finally {
      fs.rmSync(tempDirectory, { force: true, recursive: true });
    }
  });
});
