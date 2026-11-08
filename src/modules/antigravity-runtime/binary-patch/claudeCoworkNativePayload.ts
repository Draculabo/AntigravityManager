import {
  BUN_GRAPH_FOOTER_BYTES,
  readClaudeCoworkBunGraph,
  type ClaudeCoworkBunGraph,
} from './claudeCoworkBunGraph';

export interface ClaudeCoworkNativePayload {
  kind: 'bun-macho-arm64';
  start: number;
  end: number;
  graph?: ClaudeCoworkBunGraph;
}

const MACH_HEADER_64_BYTES = 32;
const LOAD_COMMAND_BYTES = 8;
const SEGMENT_64_BYTES = 72;
const SECTION_64_BYTES = 80;
const MAX_LOAD_COMMANDS = 1024;
const MAX_LOAD_COMMAND_BYTES = 256 * 1024;
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
const MH_EXECUTE = 2;
const LC_SEGMENT_64 = 0x19;
const BUN_SEGMENT = Buffer.from('__BUN\0\0\0\0\0\0\0\0\0\0\0');
const BUN_SECTION = Buffer.from('__bun\0\0\0\0\0\0\0\0\0\0\0');
const BUN_SIZE_BYTES = 8;
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');

/** Locate Bun's size-prefixed graph envelope and inspect its supported metadata layout. */
export function locateClaudeCoworkNativePayload(
  bytes: number,
  read: (offset: number, length: number) => Buffer,
): ClaudeCoworkNativePayload | null {
  if (bytes < MACH_HEADER_64_BYTES) {
    return null;
  }
  const header = read(0, MACH_HEADER_64_BYTES);
  if (
    header.readUInt32LE(0) !== MH_MAGIC_64 ||
    header.readUInt32LE(4) !== CPU_TYPE_ARM64 ||
    header.readUInt32LE(12) !== MH_EXECUTE
  ) {
    return null;
  }
  const commandCount = header.readUInt32LE(16);
  const commandBytes = header.readUInt32LE(20);
  const commandsEnd = MACH_HEADER_64_BYTES + commandBytes;
  if (
    commandCount > MAX_LOAD_COMMANDS ||
    commandBytes > MAX_LOAD_COMMAND_BYTES ||
    commandBytes < commandCount * LOAD_COMMAND_BYTES ||
    commandsEnd > bytes
  ) {
    return null;
  }

  const commands = read(MACH_HEADER_64_BYTES, commandBytes);
  const segments: { start: bigint; end: bigint }[] = [];
  const fileEnd = BigInt(bytes);
  let section: { start: number; end: number } | null = null;
  let cursor = 0;
  for (let index = 0; index < commandCount; index++) {
    if (commandBytes - cursor < LOAD_COMMAND_BYTES) {
      return null;
    }
    const type = commands.readUInt32LE(cursor);
    const size = commands.readUInt32LE(cursor + 4);
    if (size < LOAD_COMMAND_BYTES || size % 8 !== 0 || size > commandBytes - cursor) {
      return null;
    }
    const command = commands.subarray(cursor, cursor + size);
    cursor += size;
    if (type !== LC_SEGMENT_64) {
      continue;
    }
    if (size < SEGMENT_64_BYTES) {
      return null;
    }
    const sectionCount = command.readUInt32LE(64);
    if (size !== SEGMENT_64_BYTES + sectionCount * SECTION_64_BYTES) {
      return null;
    }
    const segmentStart = command.readBigUInt64LE(40);
    const segmentSize = command.readBigUInt64LE(48);
    const segmentEnd = segmentStart + segmentSize;
    if (segmentEnd > fileEnd) {
      return null;
    }
    if (!command.subarray(8, 24).equals(BUN_SEGMENT)) {
      if (segmentSize > 0n) {
        segments.push({ start: segmentStart, end: segmentEnd });
      }
      continue;
    }
    if (section || sectionCount !== 1) {
      return null;
    }
    const entry = command.subarray(SEGMENT_64_BYTES);
    const start = entry.readUInt32LE(48);
    const end = BigInt(start) + entry.readBigUInt64LE(40);
    if (
      !entry.subarray(0, 16).equals(BUN_SECTION) ||
      !entry.subarray(16, 32).equals(BUN_SEGMENT) ||
      (entry.readUInt32LE(64) & 0xff) !== 0 || // S_REGULAR
      start < commandsEnd ||
      BigInt(start) !== segmentStart ||
      end > segmentEnd ||
      end - BigInt(start) < BigInt(BUN_SIZE_BYTES + BUN_GRAPH_FOOTER_BYTES + BUN_TRAILER.length)
    ) {
      return null;
    }
    section = { start, end: Number(end) };
  }

  if (!section || cursor !== commandBytes) {
    return null;
  }
  const sectionStart = BigInt(section.start);
  const sectionEnd = BigInt(section.end);
  if (segments.some(({ start, end }) => start < sectionEnd && end > sectionStart)) {
    return null;
  }
  const start = section.start + BUN_SIZE_BYTES;
  const payloadSize = read(section.start, BUN_SIZE_BYTES).readBigUInt64LE();
  if (
    payloadSize !== BigInt(section.end - start) ||
    !read(section.end - BUN_TRAILER.length, BUN_TRAILER.length).equals(BUN_TRAILER)
  ) {
    return null;
  }
  const graph = readClaudeCoworkBunGraph({
    start,
    footerStart: section.end - BUN_TRAILER.length - BUN_GRAPH_FOOTER_BYTES,
    read,
  });
  return { kind: 'bun-macho-arm64', start, end: section.end, ...(graph ? { graph } : {}) };
}
