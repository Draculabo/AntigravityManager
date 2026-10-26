import { readX86Executable, resolveGoText, type X86Section } from './agyX86Executable';

interface GoFunction {
  end: number;
  offset: number;
  rva: number;
}

interface EligibilityFunctions {
  error: GoFunction;
  input: GoFunction;
}

interface EligibilityMatch {
  offset: number;
  state: 'already-patched' | 'patched';
}

const GO_HEADER = Buffer.from('f1ffffff00000108', 'hex');
const INPUT_SYMBOL = Buffer.from(
  'google3/third_party/jetski/cli/store/store.(*Manager).userInputLoop\0',
);
const ERROR_SYMBOL = Buffer.from(
  'google3/third_party/jetski/cli/backend/backend.(*AuthStatus).EligibilityError\0',
);
const ERROR_TITLE = Buffer.from('Eligibility Check');
const TEST_ERROR = Buffer.from('4885c0', 'hex');
const NOP_BRANCH = Buffer.alloc(6, 0x90);

function findFunctions(
  buffer: Buffer,
  header: number,
  metadata: X86Section,
  text: X86Section,
): EligibilityFunctions | null {
  if (header + 72 > metadata.offset + metadata.size) {
    return null;
  }
  const fields: number[] = [];
  for (const field of [8, 32, 40, 64]) {
    const value = buffer.readBigUInt64LE(header + field);
    if (value > BigInt(metadata.size)) {
      return null;
    }
    fields.push(Number(value));
  }
  const [count, names, namesEnd, table] = fields;
  if (count === 0 || names < 72 || names >= namesEnd || namesEnd > table) {
    return null;
  }
  const tableStart = header + table;
  const metadataEnd = metadata.offset + metadata.size;
  if (tableStart + (count + 1) * 8 > metadataEnd) {
    return null;
  }
  const nameTable = buffer.subarray(header + names, header + namesEnd);
  const inputName = nameTable.indexOf(INPUT_SYMBOL);
  const errorName = nameTable.indexOf(ERROR_SYMBOL);
  if (inputName < 0 || errorName < 0) {
    return null;
  }
  const inputs: GoFunction[] = [];
  const errors: GoFunction[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = tableStart + index * 8;
    const info = tableStart + buffer.readUInt32LE(entry + 4);
    if (info < tableStart + (count + 1) * 8 || info + 8 > metadataEnd) {
      return null;
    }
    const name = buffer.readInt32LE(info + 4);
    if (name !== inputName && name !== errorName) {
      continue;
    }
    const start = buffer.readUInt32LE(entry);
    const end = buffer.readUInt32LE(entry + 8);
    if (start >= end || end > text.size || buffer.readUInt32LE(info) !== start) {
      return null;
    }
    const target = { offset: text.offset + start, end: text.offset + end, rva: text.rva + start };
    (name === inputName ? inputs : errors).push(target);
  }
  if (inputs.length !== 1 || errors.length !== 1) {
    return null;
  }
  return { input: inputs[0], error: errors[0] };
}

function findErrorTitleReferences(
  buffer: Buffer,
  input: GoFunction,
  sections: X86Section[],
): number[] {
  const references: number[] = [];
  for (let offset = input.offset; offset + 7 <= input.end; offset += 1) {
    if (buffer[offset] !== 0x48 || buffer[offset + 1] !== 0x8d || buffer[offset + 2] !== 0x1d) {
      continue;
    }
    const rva = input.rva + offset - input.offset + 7 + buffer.readInt32LE(offset + 3);
    const section = sections.find(
      (item) =>
        !item.executable && rva >= item.rva && rva + ERROR_TITLE.length <= item.rva + item.size,
    );
    if (!section) {
      continue;
    }
    const stringOffset = section.offset + rva - section.rva;
    if (buffer.subarray(stringOffset, stringOffset + ERROR_TITLE.length).equals(ERROR_TITLE)) {
      references.push(offset);
    }
  }
  return references;
}

function findBranches(
  buffer: Buffer,
  functions: EligibilityFunctions,
  sections: X86Section[],
): EligibilityMatch[] {
  const { input, error } = functions;
  const titles = findErrorTitleReferences(buffer, input, sections);
  if (titles.length !== 1) {
    return [];
  }
  const matches: EligibilityMatch[] = [];
  for (let offset = input.offset; offset + 14 <= input.end; offset += 1) {
    if (buffer[offset] !== 0xe8 || !buffer.subarray(offset + 5, offset + 8).equals(TEST_ERROR)) {
      continue;
    }
    const callTarget = input.rva + offset - input.offset + 5 + buffer.readInt32LE(offset + 1);
    if (callTarget !== error.rva) {
      continue;
    }
    const branch = offset + 8;
    if (buffer.subarray(branch, branch + 6).equals(NOP_BRANCH)) {
      matches.push({ offset: branch, state: 'already-patched' });
      continue;
    }
    if (buffer[branch] !== 0x0f || buffer[branch + 1] !== 0x85) {
      continue;
    }
    const failure = branch + 6 + buffer.readInt32LE(branch + 2);
    if (failure > branch + 6 && failure <= titles[0] && titles[0] + 7 <= failure + 128) {
      matches.push({ offset: branch, state: 'patched' });
    }
  }
  return matches;
}

/**
 * Go 1.20+ pc/line metadata scopes the patch to the TUI input loop.
 * The old register/string-length signature also matched stream-error handling.
 * Require the named eligibility call and its UI failure target instead of
 * disabling EligibilityError globally or accepting an arbitrary nearby jump.
 */
export function findX86GoEligibilityMatches(buffer: Buffer): EligibilityMatch[] {
  const image = readX86Executable(buffer);
  if (!image) {
    return [];
  }
  const { sections } = image;
  const matches: EligibilityMatch[] = [];
  for (const section of sections.filter((item) => !item.executable)) {
    const end = section.offset + section.size;
    for (
      let header = buffer.indexOf(GO_HEADER, section.offset);
      header >= section.offset && header + 72 <= end;
      header = buffer.indexOf(GO_HEADER, header + GO_HEADER.length)
    ) {
      const text = resolveGoText(buffer, image, header);
      if (!text) {
        continue;
      }
      const functions = findFunctions(buffer, header, section, text);
      if (functions) {
        matches.push(...findBranches(buffer, functions, sections));
      }
    }
  }
  return matches;
}
