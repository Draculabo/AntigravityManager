export interface X86Section {
  executable: boolean;
  name: string;
  offset: number;
  /** Link-time image-relative address; ELF PIE relocations use the same address space. */
  rva: number;
  size: number;
}

interface X86Executable {
  format: 'pe' | 'elf';
  relocations: X86Section[];
  sections: X86Section[];
}

function contains(buffer: Buffer, offset: number, size: number): boolean {
  return offset >= 0 && size >= 0 && offset + size <= buffer.length;
}

function uint64(buffer: Buffer, offset: number): number | null {
  const value = buffer.readBigUInt64LE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function nonOverlapping(sections: X86Section[]): boolean {
  return !sections.some((section, index) =>
    sections
      .slice(index + 1)
      .some(
        (other) =>
          (section.rva < other.rva + other.size && other.rva < section.rva + section.size) ||
          (section.offset < other.offset + other.size &&
            other.offset < section.offset + section.size),
      ),
  );
}

function readPe(buffer: Buffer): X86Executable | null {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    return null;
  }
  const pe = buffer.readUInt32LE(0x3c);
  if (!contains(buffer, pe, 24) || buffer.toString('binary', pe, pe + 4) !== 'PE\0\0') {
    return null;
  }
  const optionalSize = buffer.readUInt16LE(pe + 20);
  if (optionalSize < 32 || !contains(buffer, pe + 24, optionalSize)) {
    return null;
  }
  if (buffer.readUInt16LE(pe + 4) !== 0x8664 || buffer.readUInt16LE(pe + 24) !== 0x20b) {
    return null;
  }
  const count = buffer.readUInt16LE(pe + 6);
  const table = pe + 24 + optionalSize;
  if (count === 0 || count > 96 || !contains(buffer, table, count * 40)) {
    return null;
  }
  const sections: X86Section[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = table + index * 40;
    const offset = buffer.readUInt32LE(entry + 20);
    const size = buffer.readUInt32LE(entry + 16);
    const rva = buffer.readUInt32LE(entry + 12);
    if (!contains(buffer, offset, size) || rva + size > 0x100000000) {
      return null;
    }
    if (size > 0) {
      sections.push({
        executable: (buffer.readUInt32LE(entry + 36) & 0x20000000) !== 0,
        name: buffer.toString('ascii', entry, entry + 8).replace(/\0.*$/, ''),
        offset,
        rva,
        size,
      });
    }
  }
  return nonOverlapping(sections) ? { format: 'pe', sections, relocations: [] } : null;
}

function readLoadSegments(buffer: Buffer): X86Section[] | null {
  const table = uint64(buffer, 32);
  const count = buffer.readUInt16LE(56);
  if (
    table === null ||
    buffer.readUInt16LE(54) !== 56 ||
    count === 0 ||
    count > 128 ||
    !contains(buffer, table, count * 56)
  ) {
    return null;
  }
  const segments: X86Section[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = table + index * 56;
    if (buffer.readUInt32LE(entry) !== 1) {
      continue;
    }
    const offset = uint64(buffer, entry + 8);
    const rva = uint64(buffer, entry + 16);
    const size = uint64(buffer, entry + 32);
    const memorySize = uint64(buffer, entry + 40);
    if (
      offset === null ||
      rva === null ||
      size === null ||
      memorySize === null ||
      size > memorySize ||
      !Number.isSafeInteger(rva + memorySize) ||
      !contains(buffer, offset, size)
    ) {
      return null;
    }
    segments.push({
      executable: (buffer.readUInt32LE(entry + 4) & 1) !== 0,
      name: '',
      offset,
      rva,
      size,
    });
  }
  return segments;
}

function readElf(buffer: Buffer): X86Executable | null {
  if (
    buffer.length < 64 ||
    !buffer.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])) ||
    buffer.readUInt16LE(16) !== 3 ||
    buffer.readUInt16LE(18) !== 62
  ) {
    return null;
  }
  const table = uint64(buffer, 40);
  const count = buffer.readUInt16LE(60);
  const namesIndex = buffer.readUInt16LE(62);
  const segments = readLoadSegments(buffer);
  if (
    !segments ||
    table === null ||
    buffer.readUInt16LE(58) !== 64 ||
    count === 0 ||
    count > 4096 ||
    namesIndex >= count ||
    !contains(buffer, table, count * 64)
  ) {
    return null;
  }
  const namesEntry = table + namesIndex * 64;
  const namesOffset = uint64(buffer, namesEntry + 24);
  const namesSize = uint64(buffer, namesEntry + 32);
  if (
    buffer.readUInt32LE(namesEntry + 4) !== 3 ||
    namesOffset === null ||
    namesSize === null ||
    !contains(buffer, namesOffset, namesSize)
  ) {
    return null;
  }
  const sections: X86Section[] = [];
  const relocations: X86Section[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = table + index * 64;
    const type = buffer.readUInt32LE(entry + 4);
    const flags = uint64(buffer, entry + 8);
    if (flags === null) {
      return null;
    }
    if ((flags & 2) === 0 || type === 8) {
      continue;
    }
    const offset = uint64(buffer, entry + 24);
    const size = uint64(buffer, entry + 32);
    const rva = uint64(buffer, entry + 16);
    const nameOffset = buffer.readUInt32LE(entry);
    if (
      offset === null ||
      size === null ||
      rva === null ||
      !Number.isSafeInteger(rva + size) ||
      !contains(buffer, offset, size) ||
      nameOffset >= namesSize
    ) {
      return null;
    }
    const nameEnd = buffer.indexOf(0, namesOffset + nameOffset);
    if (nameEnd < 0 || nameEnd >= namesOffset + namesSize) {
      return null;
    }
    if (size === 0) {
      continue;
    }
    const executable = (flags & 4) !== 0;
    const mapped = segments.some(
      (segment) =>
        offset >= segment.offset &&
        offset + size <= segment.offset + segment.size &&
        rva - segment.rva === offset - segment.offset &&
        (!executable || segment.executable),
    );
    if (!mapped) {
      return null;
    }
    const section = {
      executable,
      name: buffer.toString('utf8', namesOffset + nameOffset, nameEnd),
      offset,
      rva,
      size,
    };
    sections.push(section);
    if (type === 4) {
      if (uint64(buffer, entry + 56) !== 24 || size % 24 !== 0) {
        return null;
      }
      relocations.push(section);
    }
  }
  return nonOverlapping(sections) ? { format: 'elf', sections, relocations } : null;
}

export function readX86Executable(buffer: Buffer): X86Executable | null {
  return readPe(buffer) ?? readElf(buffer);
}

function findRelocations(
  buffer: Buffer,
  tables: X86Section[],
  matches: (address: number, value: number) => boolean,
) {
  const found: { address: number; value: number }[] = [];
  for (const table of tables) {
    for (let offset = table.offset; offset + 24 <= table.offset + table.size; offset += 24) {
      // R_X86_64_RELATIVE with symbol zero supplies an image-relative pointer.
      if (buffer.readBigUInt64LE(offset + 8) !== 8n) {
        continue;
      }
      const address = uint64(buffer, offset);
      const value = uint64(buffer, offset + 16);
      if (address !== null && value !== null && matches(address, value)) {
        found.push({ address, value });
      }
    }
  }
  return found;
}

export function resolveGoText(
  buffer: Buffer,
  image: X86Executable,
  header: number,
): X86Section | null {
  const code = image.sections.filter((section) => section.executable && section.name === '.text');
  if (code.length !== 1 || buffer.readBigUInt64LE(header + 24) !== 0n) {
    return null;
  }
  const text = code[0];
  if (image.format === 'pe') {
    return text;
  }
  const metadata = image.sections.find(
    (section) => header >= section.offset && header + 72 <= section.offset + section.size,
  );
  if (!metadata) {
    return null;
  }
  const headerAddress = metadata.rva + header - metadata.offset;
  const modules = findRelocations(
    buffer,
    image.relocations,
    (_address, value) => value === headerAddress,
  );
  if (
    modules.length !== 1 ||
    !image.sections.some(
      (section) =>
        !section.executable &&
        modules[0].address >= section.rva &&
        modules[0].address + 192 <= section.rva + section.size,
    )
  ) {
    return null;
  }
  // Go moduledata's text/etext fields follow its pcHeader and six slice headers.
  // ELF PIE leaves pcHeader.textStart zero; the loader relocates these fields.
  const textField = modules[0].address + 176;
  const fields = findRelocations(
    buffer,
    image.relocations,
    (address) => address === textField || address === textField + 8,
  );
  const starts = fields.filter((field) => field.address === textField);
  const ends = fields.filter((field) => field.address === textField + 8);
  if (starts.length !== 1 || ends.length !== 1) {
    return null;
  }
  const start = starts[0].value;
  const end = ends[0].value;
  if (start < text.rva || start >= end || end > text.rva + text.size) {
    return null;
  }
  return { ...text, offset: text.offset + start - text.rva, rva: start, size: end - start };
}
