import { sniffMimeType } from '../modules/files/file-mime-sniff';

function hasJpegStructure(bytes: Buffer): boolean {
  let offset = 2;
  let frame = false;
  let scan = false;
  while (offset + 1 < bytes.length) {
    if (bytes[offset++] !== 0xff) {
      return false;
    }
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      return frame && scan && offset === bytes.length;
    }
    if (offset + 2 > bytes.length) {
      return false;
    }
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) {
      return false;
    }
    if (
      marker !== undefined &&
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      if (
        length < 8 ||
        bytes.readUInt16BE(offset + 3) === 0 ||
        bytes.readUInt16BE(offset + 5) === 0
      ) {
        return false;
      }
      frame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!frame || length < 6) {
        return false;
      }
      scan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
        } else if (
          bytes[offset + 1] === 0 ||
          (bytes[offset + 1] >= 0xd0 && bytes[offset + 1] <= 0xd7)
        ) {
          offset += 2;
        } else {
          break;
        }
      }
    }
  }
  return false;
}

function hasGifStructure(bytes: Buffer): boolean {
  if (
    bytes.length < 14 ||
    !/^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6)) ||
    bytes.readUInt16LE(6) === 0 ||
    bytes.readUInt16LE(8) === 0
  ) {
    return false;
  }
  let offset = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  let image = false;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      return image && offset === bytes.length;
    }
    if (marker === 0x2c) {
      if (
        offset + 9 > bytes.length ||
        bytes.readUInt16LE(offset + 4) === 0 ||
        bytes.readUInt16LE(offset + 6) === 0
      ) {
        return false;
      }
      const packed = bytes[offset + 8];
      offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) {
        return false;
      }
      offset += 1;
      image = true;
    } else if (marker === 0x21) {
      offset += 1;
    } else {
      return false;
    }
    let length: number;
    do {
      if (offset >= bytes.length) {
        return false;
      }
      length = bytes[offset++];
      offset += length;
    } while (length > 0);
  }
  return false;
}

function hasPngStructure(bytes: Buffer): boolean {
  if (
    bytes.length < 45 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) === 0 ||
    bytes.readUInt32BE(20) === 0
  ) {
    return false;
  }
  let imageData = false;
  for (let offset = 8; offset + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      return false;
    }
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT' && length > 0) {
      imageData = true;
    }
    if (type === 'IEND') {
      return imageData && length === 0 && end === bytes.length;
    }
    offset = end;
  }
  return false;
}

function hasWebpStructure(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) {
    return false;
  }
  let imageData = false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset + 4);
    const type = bytes.toString('ascii', offset, offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) {
      return false;
    }
    imageData ||=
      (type === 'VP8 ' && length >= 10) ||
      (type === 'VP8L' && length >= 5) ||
      (type === 'ANMF' && length >= 24);
    offset = end;
  }
  return imageData && offset === bytes.length;
}

/**
 * Recognized signature and minimum container completeness, without pixel decoding.
 * PNG CRCs and codec payloads remain the decoder's responsibility; admission never
 * treats unknown binary or a header-only image as a valid declared MIME.
 */
export function validatedImageMimeType(bytes: Buffer): string {
  const mime = sniffMimeType(bytes);
  let complete = false;
  switch (mime) {
    case 'image/png':
      complete = hasPngStructure(bytes);
      break;
    case 'image/jpeg':
      complete = hasJpegStructure(bytes);
      break;
    case 'image/gif':
      complete = hasGifStructure(bytes);
      break;
    case 'image/webp':
      complete = hasWebpStructure(bytes);
      break;
    case 'image/bmp':
      complete =
        bytes.length >= 54 &&
        bytes.readUInt32LE(2) === bytes.length &&
        bytes.readUInt32LE(14) >= 40 &&
        bytes.readUInt32LE(14) <= bytes.readUInt32LE(10) - 14 &&
        bytes.readUInt32LE(10) >= 54 &&
        bytes.readUInt32LE(10) < bytes.length &&
        bytes.readInt32LE(18) > 0 &&
        bytes.readUInt16LE(26) === 1 &&
        [1, 4, 8, 16, 24, 32].includes(bytes.readUInt16LE(28)) &&
        bytes.readInt32LE(22) !== 0;
      break;
  }
  if (!mime?.startsWith('image/') || !complete) {
    throw new Error('Input image has an unsupported signature or incomplete image structure');
  }
  return mime;
}
