import { createPeEligibilityBinary } from './agy-pe-eligibility';

export const ELF_GATE_OFFSET = 0x5a8;

/** PIE layout with a relocated Go text base inside, rather than at the start of, .text. */
export function createElfEligibilityBinary(): Buffer {
  const pe = createPeEligibilityBinary();
  const binary = Buffer.alloc(0x1800);
  binary.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  binary.writeUInt16LE(3, 16);
  binary.writeUInt16LE(62, 18);
  binary.writeUInt32LE(1, 20);
  binary.writeBigUInt64LE(64n, 32);
  binary.writeBigUInt64LE(0x1400n, 40);
  binary.writeUInt16LE(64, 52);
  binary.writeUInt16LE(56, 54);
  binary.writeUInt16LE(4, 56);
  binary.writeUInt16LE(64, 58);
  binary.writeUInt16LE(6, 60);
  binary.writeUInt16LE(5, 62);
  pe.copy(binary, 0x480, 0x400, 0x800);
  pe.copy(binary, 0x900, 0x800, 0x1000);
  binary.writeInt32LE(0x3350 - 0x6257, 0x653);
  const sections = [
    ['.text', 1, 6, 0x6000, 0x400, 0x500, 0],
    ['.lrodata', 1, 2, 0x3000, 0x900, 0x800, 0],
    ['.go.module', 1, 3, 0x9000, 0x1100, 0x100, 0],
    ['.rela.dyn', 4, 2, 0xa000, 0x1200, 72, 24],
    ['.shstrtab', 3, 0, 0, 0x1300, 0x80, 0],
  ] as const;
  let nameOffset = 1;
  for (const [index, [name, type, flags, address, offset, size, entrySize]] of sections.entries()) {
    const section = 0x1440 + index * 64;
    binary.writeUInt32LE(nameOffset, section);
    nameOffset += binary.write(`${name}\0`, 0x1300 + nameOffset);
    binary.writeUInt32LE(type, section + 4);
    for (const [field, value] of [
      [8, flags],
      [16, address],
      [24, offset],
      [32, size],
      [56, entrySize],
    ]) {
      binary.writeBigUInt64LE(BigInt(value), section + field);
    }
    if (index < 4) {
      const segment = 64 + index * 56;
      binary.writeUInt32LE(1, segment);
      binary.writeUInt32LE(index === 0 ? 5 : index === 2 ? 6 : 4, segment + 4);
      binary.writeBigUInt64LE(BigInt(offset), segment + 8);
      binary.writeBigUInt64LE(BigInt(address), segment + 16);
      binary.writeBigUInt64LE(BigInt(size), segment + 32);
      binary.writeBigUInt64LE(BigInt(size), segment + 40);
    }
  }
  for (const [index, [address, value]] of [
    [0x9000, 0x3000],
    [0x90b0, 0x6080],
    [0x90b8, 0x6480],
  ].entries()) {
    const relocation = 0x1200 + index * 24;
    binary.writeBigUInt64LE(BigInt(address), relocation);
    binary.writeBigUInt64LE(8n, relocation + 8);
    binary.writeBigUInt64LE(BigInt(value), relocation + 16);
  }
  return binary;
}
