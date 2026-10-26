const SYMBOL_PREFIX = 'google3/third_party/jetski/cli/';

export const PE_GATE_OFFSET = 0x528;

/** Minimal PE/Go layout; branch bytes follow the real Windows 1.4.7 call site. */
export function createPeEligibilityBinary(callOffsets: number[] = [0x520]): Buffer {
  const binary = Buffer.alloc(0x1000);
  binary.write('MZ');
  binary.writeUInt32LE(0x80, 0x3c);
  binary.write('PE\0\0', 0x80, 'binary');
  binary.writeUInt16LE(0x8664, 0x84);
  binary.writeUInt16LE(2, 0x86);
  binary.writeUInt16LE(0xf0, 0x94);
  binary.writeUInt16LE(0x20b, 0x98);
  binary.writeBigUInt64LE(0x140000000n, 0xb0);

  for (const [index, name, rva, raw, size, flags] of [
    [0, '.text', 0x1000, 0x400, 0x400, 0x60000020],
    [1, '.rdata', 0x2000, 0x800, 0x800, 0x40000040],
  ] as const) {
    const section = 0x188 + index * 40;
    binary.write(name, section);
    binary.writeUInt32LE(size, section + 8);
    binary.writeUInt32LE(rva, section + 12);
    binary.writeUInt32LE(size, section + 16);
    binary.writeUInt32LE(raw, section + 20);
    binary.writeUInt32LE(flags, section + 36);
  }

  const header = 0x800;
  Buffer.from('f1ffffff00000108', 'hex').copy(binary, header);
  for (const [index, value] of [3, 0, 0, 72, 0x180, 0x180, 0x180, 0x200].entries()) {
    binary.writeBigUInt64LE(BigInt(value), header + 8 + index * 8);
  }
  const functions = [
    [0, `${SYMBOL_PREFIX}backend/backend.(*AuthStatus).EligibilityError`],
    [0x20, 'padding'],
    [0x100, `${SYMBOL_PREFIX}store/store.(*Manager).userInputLoop`],
  ] as const;
  let nameOffset = 0;
  for (const [index, [entry, name]] of functions.entries()) {
    const metadata = 0x30 + index * 0x20;
    binary.writeUInt32LE(entry, 0xa00 + index * 8);
    binary.writeUInt32LE(metadata, 0xa04 + index * 8);
    binary.writeUInt32LE(entry, 0xa00 + metadata);
    binary.writeInt32LE(nameOffset, 0xa04 + metadata);
    nameOffset += binary.write(`${name}\0`, header + 72 + nameOffset, 'utf8');
  }
  binary.writeUInt32LE(0x280, 0xa18);

  for (const call of callOffsets) {
    Buffer.from('e8f3f5c9ff4885c00f85db2000000fb6942494000000', 'hex').copy(binary, call);
    binary.writeInt32LE(0x400 - (call + 5), call + 1);
    binary.writeInt32LE(0x5c0 - (call + 14), call + 10);
  }
  Buffer.from('488d1da8499200', 'hex').copy(binary, 0x5d0);
  binary.writeInt32LE(0x2350 - (0x11d0 + 7), 0x5d3);
  binary.write('Eligibility Check', 0xb50);
  return binary;
}
