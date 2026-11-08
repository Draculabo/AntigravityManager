export interface ClaudeCoworkBunGraph {
  moduleCount: number;
  entryPoint: { name: string; start: number; end: number };
}

interface StringPointer {
  start: number;
  length: number;
}

// Bun v1.3.9 writes native structs in toBytes. The arm64 footer has a u64 byte count,
// two u32-pair pointers, a u32 entry index, and u32 flags. Each record has six pointers
// followed by the four u8 tags (encoding, loader, module format, side).
export const BUN_GRAPH_FOOTER_BYTES = 32;
const STRING_POINTER_BYTES = 8;
const MODULE_RECORD_BYTES = 52;
const MAX_MODULE_TABLE_BYTES = 256 * 1024;
const MAX_ENTRY_NAME_BYTES = 4096;
const VIRTUAL_PATH_PREFIX = '/$bunfs/';
const UNSAFE_PATH_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function stringPointer(buffer: Buffer, offset: number): StringPointer {
  return { start: buffer.readUInt32LE(offset), length: buffer.readUInt32LE(offset + 4) };
}

function endOf(pointer: StringPointer): number {
  return pointer.start + pointer.length;
}

export function readClaudeCoworkBunGraph({
  start,
  footerStart,
  read,
}: {
  start: number;
  footerStart: number;
  read: (offset: number, length: number) => Buffer;
}): ClaudeCoworkBunGraph | null {
  const footer = read(footerStart, BUN_GRAPH_FOOTER_BYTES);
  const tablePointer = stringPointer(footer, 8);
  const entryIndex = footer.readUInt32LE(16);
  const argvPointer = stringPointer(footer, 20);
  const moduleCount = tablePointer.length / MODULE_RECORD_BYTES;
  if (
    footer.readBigUInt64LE() !== BigInt(footerStart - start) ||
    (footer.readUInt32LE(28) >>> 4) !== 0 ||
    tablePointer.start === 0 ||
    tablePointer.length > MAX_MODULE_TABLE_BYTES ||
    !Number.isInteger(moduleCount) ||
    entryIndex >= moduleCount ||
    endOf(tablePointer) !== argvPointer.start ||
    endOf(argvPointer) + 1 !== footerStart - start
  ) {
    return null;
  }

  const table = read(start + tablePointer.start, tablePointer.length);
  for (let record = 0; record < table.length; record += MODULE_RECORD_BYTES) {
    for (let field = 0; field < 6; field++) {
      const pointer = stringPointer(table, record + field * STRING_POINTER_BYTES);
      // The name and contents always have terminators. The optional bytecode origin
      // path has one when present. Sourcemaps, bytecode and module info are byte slices.
      const terminated = field < 2 || (field === 5 && pointer.length > 0);
      if (
        (field === 0 && pointer.length === 0) ||
        endOf(pointer) + Number(terminated) > tablePointer.start
      ) {
        return null;
      }
    }
    if (
      table.readUInt8(record + 48) > 1 ||
      table.readUInt8(record + 49) > 20 ||
      table.readUInt8(record + 50) > 2 ||
      table.readUInt8(record + 51) > 1
    ) {
      return null;
    }
  }

  const entryRecord = entryIndex * MODULE_RECORD_BYTES;
  const name = stringPointer(table, entryRecord);
  const contents = stringPointer(table, entryRecord + STRING_POINTER_BYTES);
  if (
    name.length > MAX_ENTRY_NAME_BYTES ||
    contents.length === 0 ||
    endOf(name) + 1 !== contents.start ||
    read(start + endOf(contents), 1)[0] !== 0 ||
    read(start + endOf(argvPointer), 1)[0] !== 0
  ) {
    return null;
  }

  const nameBytes = read(start + name.start, name.length + 1);
  if (nameBytes[name.length] !== 0) {
    return null;
  }
  let entryName: string;
  try {
    entryName = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      nameBytes.subarray(0, name.length),
    );
  } catch {
    return null;
  }
  if (
    !entryName.startsWith(VIRTUAL_PATH_PREFIX) ||
    entryName.length === VIRTUAL_PATH_PREFIX.length ||
    UNSAFE_PATH_CHARACTERS.test(entryName)
  ) {
    return null;
  }

  return {
    moduleCount,
    entryPoint: { name: entryName, start: start + contents.start, end: start + endOf(contents) },
  };
}
