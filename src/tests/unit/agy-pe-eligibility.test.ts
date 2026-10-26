import { describe, expect, it } from 'vitest';
import { patchAgyBinaryBuffer } from '@/modules/antigravity-runtime/binary-patch/agyBinaryPatchCore';
import { createPeEligibilityBinary, PE_GATE_OFFSET } from '../fixtures/agy-pe-eligibility';

describe('PE Go eligibility target', () => {
  it('patches only the named input-loop eligibility error branch', () => {
    const source = createPeEligibilityBinary();
    const result = patchAgyBinaryBuffer(source);

    expect(result.analysis).toEqual({
      architectures: ['x86_64'],
      format: 'pe',
      patchedOffsets: [PE_GATE_OFFSET],
      status: 'patched',
    });
    const expected = Buffer.from(source);
    expected.fill(0x90, PE_GATE_OFFSET, PE_GATE_OFFSET + 6);
    expect(result.buffer).toEqual(expected);
    expect(patchAgyBinaryBuffer(result.buffer)).toEqual({
      analysis: { ...result.analysis, status: 'already-patched' },
      buffer: expected,
    });
  });

  it('rejects the old unrelated stream-error signature', () => {
    const source = createPeEligibilityBinary([]);
    Buffer.from('41803c24000f858d000000488d059118a400bb1800000031c9', 'hex').copy(source, 0x540);

    expect(() => patchAgyBinaryBuffer(source)).toThrow('No x86_64 eligibility pattern was found.');
  });

  it.each([
    {
      label: 'a different caller',
      mutate: (source: Buffer) => {
        source.write('otherInputLoop', source.indexOf('userInputLoop'));
      },
    },
    {
      label: 'a different callee',
      mutate: (source: Buffer) => {
        source.writeInt32LE(0x420 - 0x525, 0x521);
      },
    },
    {
      label: 'a branch outside the eligibility failure block',
      mutate: (source: Buffer) => {
        source.writeInt32LE(0x600 - 0x52e, 0x52a);
      },
    },
    {
      label: 'a different failure title',
      mutate: (source: Buffer) => {
        source.write('Other failure', 0xb50);
      },
    },
    {
      label: 'a partially replaced jump',
      mutate: (source: Buffer) => {
        source.fill(0x90, PE_GATE_OFFSET, PE_GATE_OFFSET + 5);
      },
    },
    {
      label: 'an ambiguous failure title',
      mutate: (source: Buffer) => {
        Buffer.from('488d1d', 'hex').copy(source, 0x5e0);
        source.writeInt32LE(0x2350 - 0x11e7, 0x5e3);
      },
    },
    {
      label: 'out-of-range Go metadata',
      mutate: (source: Buffer) => {
        source.writeBigUInt64LE(0xffffffffffffffffn, 0x840);
      },
    },
    {
      label: 'an out-of-range function record',
      mutate: (source: Buffer) => {
        source.writeUInt32LE(0xffffffff, 0xa04);
      },
    },
    {
      label: 'a function ending outside executable code',
      mutate: (source: Buffer) => {
        source.writeUInt32LE(0x500, 0xa18);
      },
    },
    {
      label: 'overlapping PE mappings',
      mutate: (source: Buffer) => {
        source.writeUInt32LE(0x1100, 0x1bc);
      },
    },
    {
      label: 'a truncated PE section table',
      mutate: (source: Buffer) => {
        source.writeUInt16LE(0xffff, 0x94);
      },
    },
  ])('rejects $label without modifying input bytes', ({ mutate }) => {
    const source = createPeEligibilityBinary();
    mutate(source);
    const original = Buffer.from(source);

    expect(() => patchAgyBinaryBuffer(source)).toThrow('No x86_64 eligibility pattern was found.');
    expect(source).toEqual(original);
  });

  it('maps Go text independently of auxiliary executable sections in real Windows builds', () => {
    const source = Buffer.concat([createPeEligibilityBinary(), Buffer.alloc(0x200)]);
    source.writeUInt16LE(3, 0x86);
    source.write('.init', 0x1d8);
    source.writeUInt32LE(0x200, 0x1e0);
    source.writeUInt32LE(0x3000, 0x1e4);
    source.writeUInt32LE(0x200, 0x1e8);
    source.writeUInt32LE(0x1000, 0x1ec);
    source.writeUInt32LE(0x60000020, 0x1fc);

    expect(patchAgyBinaryBuffer(source).analysis).toEqual({
      architectures: ['x86_64'],
      format: 'pe',
      patchedOffsets: [PE_GATE_OFFSET],
      status: 'patched',
    });
  });
});
