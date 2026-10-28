import { describe, expect, it } from 'vitest';
import { patchAgyBinaryBuffer } from '@/modules/antigravity-runtime/binary-patch/agyBinaryPatchCore';
import { createElfEligibilityBinary, ELF_GATE_OFFSET } from '../fixtures/agy-elf-eligibility';

describe('ELF Go eligibility target', () => {
  it('resolves the relocated Go text base before patching the input-loop branch', () => {
    const source = createElfEligibilityBinary();
    const expected = Buffer.from(source);
    expected.fill(0x90, ELF_GATE_OFFSET, ELF_GATE_OFFSET + 6);

    const result = patchAgyBinaryBuffer(source);

    expect(result).toEqual({
      analysis: {
        architectures: ['x86_64'],
        format: 'elf',
        patchedOffsets: [ELF_GATE_OFFSET],
        status: 'patched',
      },
      buffer: expected,
    });
    expect(patchAgyBinaryBuffer(expected)).toEqual({
      analysis: { ...result.analysis, status: 'already-patched' },
      buffer: expected,
    });
  });

  it.each([
    {
      label: 'missing module reference',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x3010n, 0x1210),
    },
    {
      label: 'missing text relocation',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0n, 0x1220),
    },
    {
      label: 'a relocation requiring symbol resolution',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x100000008n, 0x1220),
    },
    {
      label: 'a negative relocation addend',
      mutate: (source: Buffer) => source.writeBigInt64LE(-1n, 0x1228),
    },
    {
      label: 'an ambiguous text relocation',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x90b0n, 0x1230),
    },
    {
      label: 'module data outside a mapped section',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x9100n, 0x1200),
    },
    {
      label: 'an incorrect text base',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x6000n, 0x1228),
    },
    {
      label: 'a text base outside executable code',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x7000n, 0x1228),
    },
    {
      label: 'text extending beyond its executable section',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x6501n, 0x1240),
    },
    {
      label: 'a truncated program header table',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x17ffn, 32),
    },
    {
      label: 'an overflowing section table offset',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0xffffffffffffffffn, 40),
    },
    {
      label: 'an incorrect section entry size',
      mutate: (source: Buffer) => source.writeUInt16LE(32, 58),
    },
    {
      label: 'an invalid section names table index',
      mutate: (source: Buffer) => source.writeUInt16LE(6, 62),
    },
    {
      label: 'an unmapped section address',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x6010n, 0x1450),
    },
    {
      label: 'a non-executable load segment',
      mutate: (source: Buffer) => source.writeUInt32LE(4, 68),
    },
    {
      label: 'a load segment shorter than its file content',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x400n, 104),
    },
    {
      label: 'a relocation table with a truncated entry',
      mutate: (source: Buffer) => source.writeBigUInt64LE(71n, 0x1520),
    },
    {
      label: 'an unsupported relocation entry size',
      mutate: (source: Buffer) => source.writeBigUInt64LE(16n, 0x1538),
    },
    {
      label: 'a truncated allocated section',
      mutate: (source: Buffer) => source.writeBigUInt64LE(0x10000n, 0x14a0),
    },
  ])('rejects $label without modifying bytes', ({ mutate }) => {
    const source = createElfEligibilityBinary();
    mutate(source);
    const original = Buffer.from(source);

    expect(() => patchAgyBinaryBuffer(source)).toThrow('No x86_64 eligibility pattern was found.');
    expect(source).toEqual(original);
  });
});
