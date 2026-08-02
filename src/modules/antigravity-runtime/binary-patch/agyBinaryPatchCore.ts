export type AgyBinaryArchitecture = 'arm64' | 'x86_64';
export type AgyBinaryFormat = 'elf' | 'mach-o' | 'mach-o-universal' | 'pe';
export type AgyBinaryPatchStatus = 'already-patched' | 'patched';

export type AgyBinaryPatchErrorCode =
  | 'AMBIGUOUS_PATTERN'
  | 'MALFORMED_BINARY'
  | 'PATTERN_NOT_FOUND'
  | 'UNSUPPORTED_ARCHITECTURE'
  | 'UNSUPPORTED_BINARY';

export interface AgyBinaryPatchAnalysis {
  architectures: AgyBinaryArchitecture[];
  format: AgyBinaryFormat;
  patchedOffsets: number[];
  status: AgyBinaryPatchStatus;
}

export interface AgyBinaryPatchBufferResult {
  analysis: AgyBinaryPatchAnalysis;
  buffer: Buffer;
}

interface ExecutableSlice {
  architecture: AgyBinaryArchitecture;
  offset: number;
  size: number;
}

interface ParsedExecutable {
  format: AgyBinaryFormat;
  slices: ExecutableSlice[];
}

interface PatternMatch {
  offset: number;
  state: AgyBinaryPatchStatus;
}

const PE_MACHINE_X86_64 = 0x8664;
const PE_MACHINE_ARM64 = 0xaa64;
const ELF_MACHINE_X86_64 = 62;
const ELF_MACHINE_ARM64 = 183;
const MACH_CPU_X86_64 = 0x01000007;
const MACH_CPU_ARM64 = 0x0100000c;
const MACH_FAT_MAGIC = 0xcafebabe;
const MACH_FAT_64_MAGIC = 0xcafebabf;
const MAX_FAT_ARCHITECTURES = 16;

const X86_COMPARE_PREFIX = Buffer.from([0x41, 0x80, 0x3c, 0x24, 0x00]);
const X86_CONDITIONAL_BRANCH_PREFIX = Buffer.from([0x0f, 0x85]);
const X86_LEA_PREFIX = Buffer.from([0x48, 0x8d, 0x05]);
const X86_MOV_PREFIX = Buffer.from([0xbb, 0x18]);
const X86_NOP_BRANCH = Buffer.alloc(6, 0x90);

export class AgyBinaryPatchError extends Error {
  readonly code: AgyBinaryPatchErrorCode;

  constructor(code: AgyBinaryPatchErrorCode, message: string) {
    super(message);
    this.name = 'AgyBinaryPatchError';
    this.code = code;
  }
}

function architectureFromMachine(
  machine: number,
  x86Machine: number,
  armMachine: number,
): AgyBinaryArchitecture {
  if (machine === x86Machine) {
    return 'x86_64';
  }
  if (machine === armMachine) {
    return 'arm64';
  }

  throw new AgyBinaryPatchError(
    'UNSUPPORTED_ARCHITECTURE',
    `Unsupported executable architecture identifier: 0x${machine.toString(16)}.`,
  );
}

function ensureRange(buffer: Buffer, offset: number, size: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size <= 0 ||
    offset + size > buffer.length
  ) {
    throw new AgyBinaryPatchError('MALFORMED_BINARY', `Invalid ${label} range.`);
  }
}

function parsePe(buffer: Buffer): ParsedExecutable | null {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    return null;
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  ensureRange(buffer, peOffset, 6, 'PE header');
  if (!buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from('PE\0\0', 'binary'))) {
    throw new AgyBinaryPatchError('MALFORMED_BINARY', 'Invalid PE signature.');
  }

  const architecture = architectureFromMachine(
    buffer.readUInt16LE(peOffset + 4),
    PE_MACHINE_X86_64,
    PE_MACHINE_ARM64,
  );
  return {
    format: 'pe',
    slices: [{ architecture, offset: 0, size: buffer.length }],
  };
}

function parseElf(buffer: Buffer): ParsedExecutable | null {
  if (buffer.length < 20 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return null;
  }
  if (buffer[4] !== 2) {
    throw new AgyBinaryPatchError(
      'UNSUPPORTED_ARCHITECTURE',
      'Only 64-bit ELF files are supported.',
    );
  }

  const endian = buffer[5];
  if (endian !== 1) {
    throw new AgyBinaryPatchError(
      'UNSUPPORTED_BINARY',
      'Only little-endian ELF executables are supported.',
    );
  }

  const machine = buffer.readUInt16LE(18);
  const architecture = architectureFromMachine(machine, ELF_MACHINE_X86_64, ELF_MACHINE_ARM64);
  return {
    format: 'elf',
    slices: [{ architecture, offset: 0, size: buffer.length }],
  };
}

function readMachArchitecture(buffer: Buffer, offset: number): AgyBinaryArchitecture | null {
  ensureRange(buffer, offset, 8, 'Mach-O header');
  const magic = buffer.subarray(offset, offset + 4);
  const isLittleEndian = magic.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  const isBigEndian = magic.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf]));
  if (!isLittleEndian && !isBigEndian) {
    return null;
  }
  if (isBigEndian) {
    throw new AgyBinaryPatchError(
      'UNSUPPORTED_BINARY',
      'Only little-endian 64-bit Mach-O executables are supported.',
    );
  }

  const cpuType = buffer.readUInt32LE(offset + 4);
  return architectureFromMachine(cpuType, MACH_CPU_X86_64, MACH_CPU_ARM64);
}

function parseFatMachO(buffer: Buffer): ParsedExecutable | null {
  if (buffer.length < 8) {
    return null;
  }

  const magic = buffer.readUInt32BE(0);
  const isFat32 = magic === MACH_FAT_MAGIC;
  const isFat64 = magic === MACH_FAT_64_MAGIC;
  if (!isFat32 && !isFat64) {
    return null;
  }

  const architectureCount = buffer.readUInt32BE(4);
  if (architectureCount === 0 || architectureCount > MAX_FAT_ARCHITECTURES) {
    throw new AgyBinaryPatchError(
      'MALFORMED_BINARY',
      `Invalid Mach-O architecture count: ${architectureCount}.`,
    );
  }

  const entrySize = isFat64 ? 32 : 20;
  ensureRange(buffer, 8, architectureCount * entrySize, 'Mach-O architecture table');
  const slices: ExecutableSlice[] = [];

  for (let index = 0; index < architectureCount; index += 1) {
    const entryOffset = 8 + index * entrySize;
    const cpuType = buffer.readUInt32BE(entryOffset);
    let architecture: AgyBinaryArchitecture;
    try {
      architecture = architectureFromMachine(cpuType, MACH_CPU_X86_64, MACH_CPU_ARM64);
    } catch (error) {
      if (error instanceof AgyBinaryPatchError && error.code === 'UNSUPPORTED_ARCHITECTURE') {
        continue;
      }
      throw error;
    }

    const sliceOffset = isFat64
      ? Number(buffer.readBigUInt64BE(entryOffset + 8))
      : buffer.readUInt32BE(entryOffset + 8);
    const sliceSize = isFat64
      ? Number(buffer.readBigUInt64BE(entryOffset + 16))
      : buffer.readUInt32BE(entryOffset + 12);
    ensureRange(buffer, sliceOffset, sliceSize, `Mach-O ${architecture} slice`);

    const innerArchitecture = readMachArchitecture(buffer, sliceOffset);
    if (innerArchitecture !== architecture) {
      throw new AgyBinaryPatchError(
        'MALFORMED_BINARY',
        `Mach-O ${architecture} slice header does not match its architecture table entry.`,
      );
    }
    slices.push({ architecture, offset: sliceOffset, size: sliceSize });
  }

  if (slices.length === 0) {
    throw new AgyBinaryPatchError(
      'UNSUPPORTED_ARCHITECTURE',
      'The universal Mach-O file has no supported ARM64 or x86_64 slices.',
    );
  }

  return { format: 'mach-o-universal', slices };
}

function parseThinMachO(buffer: Buffer): ParsedExecutable | null {
  const architecture = readMachArchitecture(buffer, 0);
  if (!architecture) {
    return null;
  }

  return {
    format: 'mach-o',
    slices: [{ architecture, offset: 0, size: buffer.length }],
  };
}

function parseExecutable(buffer: Buffer): ParsedExecutable {
  const parsed =
    parsePe(buffer) ?? parseElf(buffer) ?? parseFatMachO(buffer) ?? parseThinMachO(buffer);
  if (!parsed) {
    throw new AgyBinaryPatchError(
      'UNSUPPORTED_BINARY',
      'The selected file is not a supported PE, Mach-O, or ELF executable.',
    );
  }

  return parsed;
}

function bytesEqual(buffer: Buffer, offset: number, expected: Buffer): boolean {
  return buffer.subarray(offset, offset + expected.length).equals(expected);
}

function findX86Matches(buffer: Buffer, slice: ExecutableSlice): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const start = slice.offset;
  const end = slice.offset + slice.size;
  const patternSize = 20;

  for (let offset = start; offset + patternSize <= end; offset += 1) {
    if (
      !bytesEqual(buffer, offset, X86_COMPARE_PREFIX) ||
      !bytesEqual(buffer, offset + 11, X86_LEA_PREFIX) ||
      !bytesEqual(buffer, offset + 18, X86_MOV_PREFIX)
    ) {
      continue;
    }

    if (bytesEqual(buffer, offset + 5, X86_CONDITIONAL_BRANCH_PREFIX)) {
      matches.push({ offset: offset + 5, state: 'patched' });
      continue;
    }
    if (bytesEqual(buffer, offset + 5, X86_NOP_BRANCH)) {
      matches.push({ offset: offset + 5, state: 'already-patched' });
    }
  }

  return matches;
}

function findArm64Matches(buffer: Buffer, slice: ExecutableSlice): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const start = slice.offset;
  const end = slice.offset + slice.size;

  for (let offset = start; offset + 20 <= end; offset += 4) {
    const firstInstruction = buffer.readUInt32LE(offset);
    const secondInstruction = buffer.readUInt32LE(offset + 4);
    const fourthInstruction = buffer.readUInt32LE(offset + 12);
    const fifthInstruction = buffer.readUInt32LE(offset + 16);

    if ((firstInstruction & 0xfffffc00) >>> 0 !== 0x39416000) {
      continue;
    }
    const sourceRegister = (firstInstruction >>> 5) & 0x1f;
    const flagRegister = firstInstruction & 0x1f;
    if ((secondInstruction & 0xffe0001f) >>> 0 !== (0x37000000 | flagRegister) >>> 0) {
      continue;
    }
    if (
      (fourthInstruction & 0xfffffc00) >>> 0 !== 0xf9401c00 ||
      ((fourthInstruction >>> 5) & 0x1f) !== sourceRegister
    ) {
      continue;
    }

    const targetRegister = fourthInstruction & 0x1f;
    if ((fifthInstruction & 0xff00001f) >>> 0 === (0xb4000000 | targetRegister) >>> 0) {
      matches.push({ offset: offset + 16, state: 'patched' });
      continue;
    }
    if ((fifthInstruction & 0xfc000000) >>> 0 === 0x14000000) {
      matches.push({ offset: offset + 16, state: 'already-patched' });
    }
  }

  return matches;
}

function getUniqueMatch(buffer: Buffer, slice: ExecutableSlice): PatternMatch {
  const matches =
    slice.architecture === 'x86_64'
      ? findX86Matches(buffer, slice)
      : findArm64Matches(buffer, slice);
  if (matches.length === 0) {
    throw new AgyBinaryPatchError(
      'PATTERN_NOT_FOUND',
      `No ${slice.architecture} eligibility pattern was found.`,
    );
  }
  if (matches.length > 1) {
    throw new AgyBinaryPatchError(
      'AMBIGUOUS_PATTERN',
      `Found ${matches.length} ${slice.architecture} eligibility patterns; expected exactly one.`,
    );
  }

  return matches[0];
}

function patchX86Match(buffer: Buffer, offset: number): void {
  X86_NOP_BRANCH.copy(buffer, offset);
}

function patchArm64Match(buffer: Buffer, offset: number): void {
  const conditionalBranch = buffer.readUInt32LE(offset);
  const immediateRaw = (conditionalBranch >>> 5) & 0x7ffff;
  const signedImmediate = (immediateRaw & 0x40000) !== 0 ? immediateRaw - 0x80000 : immediateRaw;
  const unconditionalBranch = (0x14000000 | (signedImmediate & 0x03ffffff)) >>> 0;
  buffer.writeUInt32LE(unconditionalBranch, offset);
}

export function patchAgyBinaryBuffer(source: Buffer): AgyBinaryPatchBufferResult {
  const parsed = parseExecutable(source);
  const output = Buffer.from(source);
  const matches = parsed.slices.map((slice) => ({
    match: getUniqueMatch(source, slice),
    slice,
  }));

  for (const item of matches) {
    if (item.match.state === 'already-patched') {
      continue;
    }
    if (item.slice.architecture === 'x86_64') {
      patchX86Match(output, item.match.offset);
    } else {
      patchArm64Match(output, item.match.offset);
    }
  }

  const verificationMatches = parsed.slices.map((slice) => getUniqueMatch(output, slice));
  if (verificationMatches.some((match) => match.state !== 'already-patched')) {
    throw new AgyBinaryPatchError(
      'PATTERN_NOT_FOUND',
      'The patched binary did not pass post-write instruction verification.',
    );
  }

  return {
    analysis: {
      architectures: parsed.slices.map((slice) => slice.architecture),
      format: parsed.format,
      patchedOffsets: matches.map((item) => item.match.offset),
      status: matches.some((item) => item.match.state === 'patched')
        ? 'patched'
        : 'already-patched',
    },
    buffer: output,
  };
}
