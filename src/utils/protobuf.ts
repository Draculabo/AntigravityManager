export class ProtobufUtils {
  static encodeVarint(value: number): Uint8Array {
    // Note: Javascript bitwise operators treat operands as 32-bit integers.
    // However, for typical token lengths and small field IDs, this is fine.
    // Expiry timestamp (seconds) fits in 32-bit (until 2038) but might exceed if it's milliseconds.
    // The Rust code uses u64 (seconds).
    // If value is larger than 2^32, we need BigInt.

    const buf: number[] = [];
    let val = BigInt(value);

    while (val >= 128n) {
      buf.push(Number((val & 127n) | 128n));
      val >>= 7n;
    }
    buf.push(Number(val));
    return new Uint8Array(buf);
  }

  static readVarint(data: Uint8Array, offset: number): { value: bigint; nextOffset: number } {
    let result = 0n;
    let shift = 0n;
    let pos = offset;

    while (pos < data.length) {
      const byte = BigInt(data[pos]);
      result |= (byte & 127n) << shift;
      pos++;
      if ((byte & 128n) === 0n) {
        return { value: result, nextOffset: pos };
      }
      shift += 7n;
    }
    throw new Error('Incomplete varint data');
  }

  // Skip a field based on wire type
  static skipField(data: Uint8Array, offset: number, wireType: number): number {
    switch (wireType) {
      case 0: // Varint
        return this.readVarint(data, offset).nextOffset;
      case 1: // 64-bit
        return offset + 8;
      case 2: // Length-delimited
        const { value: length, nextOffset } = this.readVarint(data, offset);
        return nextOffset + Number(length);
      case 5: // 32-bit
        return offset + 4;
      default:
        throw new Error(`Unknown wire type: ${wireType}`);
    }
  }

  static removeField(data: Uint8Array, fieldNum: number): Uint8Array {
    const result: number[] = [];
    let offset = 0;

    while (offset < data.length) {
      const startOffset = offset;
      const { value: tag, nextOffset } = this.readVarint(data, offset);
      const wireType = Number(tag & 7n);
      const currentField = Number(tag >> 3n);

      if (currentField === fieldNum) {
        // Skip
        offset = this.skipField(data, nextOffset, wireType);
      } else {
        // Copy
        const endOffset = this.skipField(data, nextOffset, wireType);
        for (let i = startOffset; i < endOffset; i++) {
          result.push(data[i]);
        }
        offset = endOffset;
      }
    }
    return new Uint8Array(result);
  }

  // Create string field (WireType 2)
  static createStringField(fieldNum: number, value: string): Uint8Array {
    const tag = (fieldNum << 3) | 2;
    const utf8Encode = new TextEncoder();
    const bytes = utf8Encode.encode(value);

    const tagBytes = this.encodeVarint(tag);
    const lenBytes = this.encodeVarint(bytes.length);

    const result = new Uint8Array(tagBytes.length + lenBytes.length + bytes.length);
    result.set(tagBytes, 0);
    result.set(lenBytes, tagBytes.length);
    result.set(bytes, tagBytes.length + lenBytes.length);
    return result;
  }

  // Create timestamp field (Field 4 -> Field 1 varint)
  static createTimestampField(fieldNum: number, seconds: number): Uint8Array {
    // Timestamp message format: Field 1 (seconds) as varint
    const innerTag = (1 << 3) | 0;
    const innerTagBytes = this.encodeVarint(innerTag);
    const secondsBytes = this.encodeVarint(seconds);

    const innerMsg = new Uint8Array(innerTagBytes.length + secondsBytes.length);
    innerMsg.set(innerTagBytes, 0);
    innerMsg.set(secondsBytes, innerTagBytes.length);

    // Wrap in length delimited
    const tag = (fieldNum << 3) | 2;
    const tagBytes = this.encodeVarint(tag);
    const lenBytes = this.encodeVarint(innerMsg.length);

    const result = new Uint8Array(tagBytes.length + lenBytes.length + innerMsg.length);
    result.set(tagBytes, 0);
    result.set(lenBytes, tagBytes.length);
    result.set(innerMsg, tagBytes.length + lenBytes.length);
    return result;
  }

  // Extract field by ID
  static getField(data: Uint8Array, fieldNum: number): Uint8Array | null {
    let offset = 0;
    while (offset < data.length) {
      const { value: tag, nextOffset } = this.readVarint(data, offset);
      const wireType = Number(tag & 7n);
      const currentField = Number(tag >> 3n);

      if (currentField === fieldNum) {
        if (wireType === 2) {
          // Length delimited
          const { value: length, nextOffset: dataStart } = this.readVarint(data, nextOffset);
          return data.slice(dataStart, dataStart + Number(length));
        }
        // For sync feature, we mainly care about wireType 2 (string/bytes)
        return null;
      }

      offset = this.skipField(data, nextOffset, wireType);
    }
    return null;
  }

  static readString(data: Uint8Array): string {
    const dec = new TextDecoder();
    return dec.decode(data);
  }

  static extractOAuthTokenInfo(
    data: Uint8Array,
  ): { accessToken: string; refreshToken: string } | null {
    // 1. Find Field 6 (OAuthTokenInfo)
    const field6Data = this.getField(data, 6);
    if (!field6Data) return null;

    // 2. Parse Field 6 content
    // Field 1: Access Token (String)
    // Field 2: Type (String, "Bearer")
    // Field 3: Refresh Token (String)
    // Field 4: Expiry (Varint? Timestamp?) - In create we used createTimestampField which effectively makes it Field 4 -> Field 1.
    // But here we just need Access/Refresh.

    const accessTokenBytes = this.getField(field6Data, 1);
    const refreshTokenBytes = this.getField(field6Data, 3);

    if (accessTokenBytes && refreshTokenBytes) {
      return {
        accessToken: this.readString(accessTokenBytes),
        refreshToken: this.readString(refreshTokenBytes),
      };
    }
    return null;
  }

  static createOAuthTokenInfo(
    accessToken: string,
    refreshToken: string,
    expiry: number,
  ): Uint8Array {
    const f1 = this.createStringField(1, accessToken);
    const f2 = this.createStringField(2, 'Bearer');
    const f3 = this.createStringField(3, refreshToken);
    const f4 = this.createTimestampField(4, expiry);

    const combined = new Uint8Array(f1.length + f2.length + f3.length + f4.length);
    combined.set(f1, 0);
    combined.set(f2, f1.length);
    combined.set(f3, f1.length + f2.length);
    combined.set(f4, f1.length + f2.length + f3.length);

    // Wrap as Field 6
    const tag6 = (6 << 3) | 2;
    const tag6Bytes = this.encodeVarint(tag6);
    const lenBytes = this.encodeVarint(combined.length);

    const result = new Uint8Array(tag6Bytes.length + lenBytes.length + combined.length);
    result.set(tag6Bytes, 0);
    result.set(lenBytes, tag6Bytes.length);
    result.set(combined, tag6Bytes.length + lenBytes.length);

    return result;
  }
}
