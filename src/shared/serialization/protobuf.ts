export class ProtobufUtils {
  private static concatBytes(...parts: Uint8Array[]): Uint8Array {
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged;
  }

  static encodeVarint(value: number): Uint8Array {
    // Note: Javascript bitwise operators treat operands as 32-bit integers.
    // However, for typical token lengths and small field IDs, this is fine.
    // Expiry timestamp (seconds) fits in 32-bit (until 2038) but might exceed if it's milliseconds.
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
      case 2: {
        // Length-delimited
        const { value: length, nextOffset } = this.readVarint(data, offset);
        return nextOffset + Number(length);
      }
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

  static encodeLenDelimField(fieldNum: number, data: Uint8Array): Uint8Array {
    const tag = (fieldNum << 3) | 2;
    const tagBytes = this.encodeVarint(tag);
    const lenBytes = this.encodeVarint(data.length);

    const result = new Uint8Array(tagBytes.length + lenBytes.length + data.length);
    result.set(tagBytes, 0);
    result.set(lenBytes, tagBytes.length);
    result.set(data, tagBytes.length + lenBytes.length);
    return result;
  }

  static encodeStringField(fieldNum: number, value: string): Uint8Array {
    const utf8Encode = new TextEncoder();
    const bytes = utf8Encode.encode(value);
    return this.encodeLenDelimField(fieldNum, bytes);
  }

  static encodeVarintField(fieldNum: number, value: number): Uint8Array {
    const tag = (fieldNum << 3) | 0;
    const tagBytes = this.encodeVarint(tag);
    const valueBytes = this.encodeVarint(value);
    return this.concatBytes(tagBytes, valueBytes);
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
    const decoder = new TextDecoder();
    return decoder.decode(data);
  }

  static extractOAuthTokenInfo(
    data: Uint8Array,
  ): { accessToken: string; refreshToken: string; idToken?: string } | null {
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
    const idTokenBytes = this.getField(field6Data, 5);

    if (accessTokenBytes && refreshTokenBytes) {
      return {
        accessToken: this.readString(accessTokenBytes),
        refreshToken: this.readString(refreshTokenBytes),
        idToken: idTokenBytes ? this.readString(idTokenBytes) : undefined,
      };
    }
    return null;
  }

  static createOAuthTokenInfo(
    accessToken: string,
    refreshToken: string,
    expiry: number,
  ): Uint8Array {
    const accessTokenField = this.createStringField(1, accessToken);
    const tokenTypeField = this.createStringField(2, 'Bearer');
    const refreshTokenField = this.createStringField(3, refreshToken);
    const expiryField = this.createTimestampField(4, expiry);

    const oauthTokenInfoPayload = this.concatBytes(
      accessTokenField,
      tokenTypeField,
      refreshTokenField,
      expiryField,
    );

    // Wrap as Field 6
    const oauthTokenInfoTag = (6 << 3) | 2;
    const tagBytes = this.encodeVarint(oauthTokenInfoTag);
    const lengthBytes = this.encodeVarint(oauthTokenInfoPayload.length);

    const result = new Uint8Array(
      tagBytes.length + lengthBytes.length + oauthTokenInfoPayload.length,
    );
    result.set(tagBytes, 0);
    result.set(lengthBytes, tagBytes.length);
    result.set(oauthTokenInfoPayload, tagBytes.length + lengthBytes.length);

    return result;
  }

  static createOAuthInfo(
    accessToken: string,
    refreshToken: string,
    expiry: number,
    isGcpTos = false,
    idToken?: string,
    email?: string,
  ): Uint8Array {
    let shouldIncludeGcpTosFlag = isGcpTos;
    if (email && this.isPersonalAccountEmail(email) && shouldIncludeGcpTosFlag) {
      shouldIncludeGcpTosFlag = false;
    }

    const accessTokenField = this.encodeStringField(1, accessToken);
    const tokenTypeField = this.encodeStringField(2, 'Bearer');
    const refreshTokenField = this.encodeStringField(3, refreshToken);

    const timestampMsg = this.concatBytes(
      this.encodeVarintField(1, expiry),
      this.encodeVarintField(2, 0),
    );

    const expiryField = this.encodeLenDelimField(4, timestampMsg);
    const idTokenField = idToken ? this.encodeStringField(5, idToken) : new Uint8Array();
    const gcpTosField = shouldIncludeGcpTosFlag ? this.encodeVarintField(6, 1) : new Uint8Array();

    return this.concatBytes(
      accessTokenField,
      tokenTypeField,
      refreshTokenField,
      expiryField,
      idTokenField,
      gcpTosField,
    );
  }

  static createUnifiedOAuthToken(
    accessToken: string,
    refreshToken: string,
    expiry: number,
    isGcpTos = false,
    idToken?: string,
    email?: string,
  ): string {
    const oauthInfo = this.createOAuthInfo(
      accessToken,
      refreshToken,
      expiry,
      isGcpTos,
      idToken,
      email,
    );
    return this.createUnifiedStateEntry('oauthTokenInfoSentinelKey', oauthInfo);
  }

  private static isPersonalAccountEmail(email: string): boolean {
    const lowerEmail = email.toLowerCase();
    return (
      lowerEmail.endsWith('@gmail.com') ||
      lowerEmail.endsWith('@outlook.com') ||
      lowerEmail.endsWith('@hotmail.com') ||
      lowerEmail.endsWith('@qq.com') ||
      lowerEmail.endsWith('@163.com')
    );
  }

  static extractOAuthTokenInfoFromOAuthInfo(
    data: Uint8Array,
  ): { accessToken: string; refreshToken: string; idToken?: string } | null {
    const accessTokenBytes = this.getField(data, 1);
    const refreshTokenBytes = this.getField(data, 3);
    const idTokenBytes = this.getField(data, 5);

    if (accessTokenBytes && refreshTokenBytes) {
      return {
        accessToken: this.readString(accessTokenBytes),
        refreshToken: this.readString(refreshTokenBytes),
        idToken: idTokenBytes ? this.readString(idTokenBytes) : undefined,
      };
    }
    return null;
  }

  static extractOAuthTokenDetailsFromOAuthInfo(data: Uint8Array): {
    accessToken: string;
    refreshToken: string;
    expiryTimestamp: number;
    idToken?: string;
  } | null {
    const accessTokenBytes = this.getField(data, 1);
    const refreshTokenBytes = this.getField(data, 3);
    const expiryBytes = this.getField(data, 4);
    const idTokenBytes = this.getField(data, 5);

    if (!accessTokenBytes || !refreshTokenBytes || !expiryBytes) {
      return null;
    }

    const expiryTimestamp = this.findVarintField(expiryBytes, 1);
    if (!expiryTimestamp) {
      return null;
    }

    return {
      accessToken: this.readString(accessTokenBytes),
      refreshToken: this.readString(refreshTokenBytes),
      expiryTimestamp,
      idToken: idTokenBytes ? this.readString(idTokenBytes) : undefined,
    };
  }

  static extractOAuthTokenInfoFromUnifiedState(
    data: Uint8Array,
  ): { accessToken: string; refreshToken: string; idToken?: string } | null {
    try {
      for (const decoded of this.decodeUnifiedStateTopicEntries(data)) {
        if (decoded.sentinelKey !== 'oauthTokenInfoSentinelKey') {
          continue;
        }

        const parsed = this.extractOAuthTokenInfoFromUnifiedPayload(decoded.payload);
        if (parsed) {
          return parsed;
        }
      }

      return null;
    } catch {
      try {
        const decoded = this.decodeLegacyUnifiedStateEntry(data);
        if (decoded.sentinelKey !== 'oauthTokenInfoSentinelKey') {
          return null;
        }

        return this.extractOAuthTokenInfoFromUnifiedPayload(decoded.payload);
      } catch {
        return null;
      }
    }
  }

  private static extractOAuthTokenInfoFromUnifiedPayload(
    payload: Uint8Array,
  ): { accessToken: string; refreshToken: string; idToken?: string } | null {
    const directParsed = this.extractOAuthTokenInfoFromOAuthInfo(payload);
    if (directParsed) {
      return directParsed;
    }
    const nestedOauthInfoB64Bytes = this.getField(payload, 1);
    if (!nestedOauthInfoB64Bytes) {
      return null;
    }

    try {
      const nestedOauthInfoBytes = new Uint8Array(
        Buffer.from(this.readString(nestedOauthInfoB64Bytes), 'base64'),
      );
      return this.extractOAuthTokenInfoFromOAuthInfo(nestedOauthInfoBytes);
    } catch {
      return null;
    }
  }

  private static decodeLegacyBase64PayloadIfNeeded(payload: Uint8Array): Uint8Array {
    if (payload.length === 0 || payload.length % 4 !== 0) {
      return payload;
    }

    let looksLikeBase64 = true;
    for (const byte of payload) {
      const isBase64Byte =
        (byte >= 65 && byte <= 90) ||
        (byte >= 97 && byte <= 122) ||
        (byte >= 48 && byte <= 57) ||
        byte === 43 ||
        byte === 47 ||
        byte === 61;
      if (!isBase64Byte) {
        looksLikeBase64 = false;
        break;
      }
    }

    if (!looksLikeBase64) {
      return payload;
    }

    try {
      const encoded = Buffer.from(payload).toString('utf8');
      const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));
      if (decoded.length === 0) {
        return payload;
      }
      return decoded;
    } catch {
      return payload;
    }
  }

  private static decodeTopicRowPayload(topicBlob: Uint8Array): {
    sentinelKey: string;
    payload: Uint8Array;
  } {
    const dataEntry = this.getField(topicBlob, 1);
    if (!dataEntry) {
      throw new Error('Topic data entry not found');
    }

    const sentinelKeyBytes = this.getField(dataEntry, 1);
    if (!sentinelKeyBytes) {
      throw new Error('Topic data entry key not found');
    }

    const rowBlob = this.getField(dataEntry, 2);
    if (!rowBlob) {
      throw new Error('Topic row not found');
    }

    const encodedPayloadBytes = this.getField(rowBlob, 1);
    if (!encodedPayloadBytes) {
      throw new Error('Topic row value not found');
    }

    const sentinelKey = this.readString(sentinelKeyBytes);
    const encodedPayload = this.readString(encodedPayloadBytes);
    const payload = new Uint8Array(Buffer.from(encodedPayload, 'base64'));

    return { sentinelKey, payload };
  }

  private static decodeLegacyUnifiedStateEntry(outerBlob: Uint8Array): {
    sentinelKey: string;
    payload: Uint8Array;
  } {
    const innerBlob = this.getField(outerBlob, 1);
    if (!innerBlob) {
      throw new Error('Outer Field 1 not found');
    }

    const sentinelKeyBytes = this.getField(innerBlob, 1);
    if (!sentinelKeyBytes) {
      throw new Error('Inner Field 1 not found');
    }

    const payload = this.getField(innerBlob, 2);
    if (!payload) {
      throw new Error('Inner Field 2 not found');
    }

    return {
      sentinelKey: this.readString(sentinelKeyBytes),
      payload: this.decodeLegacyBase64PayloadIfNeeded(payload),
    };
  }

  static createUnifiedStateEntry(sentinelKey: string, payload: Uint8Array): string {
    const topic = this.createUnifiedTopicEntry(sentinelKey, payload);
    return Buffer.from(topic).toString('base64');
  }

  static createUnifiedTopicEntry(sentinelKey: string, payload: Uint8Array): Uint8Array {
    const row = this.encodeStringField(1, Buffer.from(payload).toString('base64'));
    const dataEntry = this.concatBytes(
      this.encodeStringField(1, sentinelKey),
      this.encodeLenDelimField(2, row),
    );
    return this.encodeLenDelimField(1, dataEntry);
  }

  static concatUnifiedTopicEntries(...entries: Uint8Array[]): Uint8Array {
    return this.concatBytes(...entries);
  }

  static decodeUnifiedStateTopicEntries(
    topicBlob: Uint8Array,
  ): Array<{ sentinelKey: string; payload: Uint8Array }> {
    const entries: Array<{ sentinelKey: string; payload: Uint8Array }> = [];
    let offset = 0;

    while (offset < topicBlob.length) {
      const fieldStartOffset = offset;
      const { value: tag, nextOffset } = this.readVarint(topicBlob, offset);
      const wireType = Number(tag & 7n);
      const currentField = Number(tag >> 3n);
      const fieldEndOffset = this.skipField(topicBlob, nextOffset, wireType);

      if (currentField === 1 && wireType === 2) {
        const { value: length, nextOffset: dataStart } = this.readVarint(topicBlob, nextOffset);
        const dataEnd = dataStart + Number(length);
        const dataEntry = topicBlob.slice(dataStart, dataEnd);
        entries.push(this.decodeTopicDataEntry(dataEntry));
      }

      offset = fieldEndOffset;
      if (offset <= fieldStartOffset) {
        throw new Error('Failed to advance while decoding unified topic entries');
      }
    }

    return entries;
  }

  static removeUnifiedTopicEntry(topicBlob: Uint8Array, targetSentinelKey: string): Uint8Array {
    const chunks: Uint8Array[] = [];
    let offset = 0;

    while (offset < topicBlob.length) {
      const fieldStartOffset = offset;
      const { value: tag, nextOffset } = this.readVarint(topicBlob, offset);
      const wireType = Number(tag & 7n);
      const currentField = Number(tag >> 3n);
      const fieldEndOffset = this.skipField(topicBlob, nextOffset, wireType);
      let shouldRemove = false;

      if (currentField === 1 && wireType === 2) {
        const { value: length, nextOffset: dataStart } = this.readVarint(topicBlob, nextOffset);
        const dataEntry = topicBlob.slice(dataStart, dataStart + Number(length));
        shouldRemove = this.getUnifiedTopicEntryKey(dataEntry) === targetSentinelKey;
      }

      if (!shouldRemove) {
        chunks.push(topicBlob.slice(fieldStartOffset, fieldEndOffset));
      }

      offset = fieldEndOffset;
    }

    return this.concatBytes(...chunks);
  }

  static replaceUnifiedTopicEntry(
    topicBlob: Uint8Array,
    sentinelKey: string,
    payload: Uint8Array,
  ): Uint8Array {
    return this.concatBytes(
      this.removeUnifiedTopicEntry(topicBlob, sentinelKey),
      this.createUnifiedTopicEntry(sentinelKey, payload),
    );
  }

  private static decodeTopicDataEntry(dataEntry: Uint8Array): {
    sentinelKey: string;
    payload: Uint8Array;
  } {
    const sentinelKeyBytes = this.getField(dataEntry, 1);
    if (!sentinelKeyBytes) {
      throw new Error('Topic data entry key not found');
    }

    const rowBlob = this.getField(dataEntry, 2);
    if (!rowBlob) {
      throw new Error('Topic row not found');
    }

    const encodedPayloadBytes = this.getField(rowBlob, 1);
    if (!encodedPayloadBytes) {
      throw new Error('Topic row value not found');
    }

    return {
      sentinelKey: this.readString(sentinelKeyBytes),
      payload: new Uint8Array(Buffer.from(this.readString(encodedPayloadBytes), 'base64')),
    };
  }

  private static getUnifiedTopicEntryKey(dataEntry: Uint8Array): string | null {
    const sentinelKeyBytes = this.getField(dataEntry, 1);
    if (!sentinelKeyBytes) {
      return null;
    }

    return this.readString(sentinelKeyBytes);
  }

  static decodeUnifiedStateEntry(outerB64: string): { sentinelKey: string; payload: Uint8Array } {
    const outerBlob = new Uint8Array(Buffer.from(outerB64, 'base64'));

    try {
      return this.decodeTopicRowPayload(outerBlob);
    } catch {
      return this.decodeLegacyUnifiedStateEntry(outerBlob);
    }
  }

  static findVarintField(data: Uint8Array, targetField: number): number | null {
    let offset = 0;
    while (offset < data.length) {
      const { value: tag, nextOffset } = this.readVarint(data, offset);
      const wireType = Number(tag & 7n);
      const currentField = Number(tag >> 3n);

      if (currentField === targetField && wireType === 0) {
        const { value } = this.readVarint(data, nextOffset);
        return Number(value);
      }

      offset = this.skipField(data, nextOffset, wireType);
    }

    return null;
  }

  static createStringValuePayload(value: string): Uint8Array {
    return this.encodeStringField(3, value);
  }

  static createMinimalUserStatusPayload(email: string): Uint8Array {
    return this.concatBytes(this.encodeStringField(3, email), this.encodeStringField(7, email));
  }

  static extractOAuthTokenInfoFromUnifiedStateEntry(
    outerB64: string,
  ): { accessToken: string; refreshToken: string; idToken?: string } | null {
    return this.extractOAuthTokenInfoFromUnifiedState(
      new Uint8Array(Buffer.from(outerB64, 'base64')),
    );
  }

  static extractOAuthTokenDetailsFromUnifiedStateEntry(outerB64: string): {
    accessToken: string;
    refreshToken: string;
    expiryTimestamp: number;
    idToken?: string;
  } | null {
    let decoded: { sentinelKey: string; payload: Uint8Array };
    try {
      decoded = this.decodeUnifiedStateEntry(outerB64);
    } catch {
      return null;
    }

    if (decoded.sentinelKey !== 'oauthTokenInfoSentinelKey') {
      return null;
    }

    const directParsed = this.extractOAuthTokenDetailsFromOAuthInfo(decoded.payload);
    if (directParsed) {
      return directParsed;
    }
    const nestedOauthInfoB64Bytes = this.getField(decoded.payload, 1);
    if (!nestedOauthInfoB64Bytes) {
      return null;
    }

    try {
      const nestedOauthInfoBytes = new Uint8Array(
        Buffer.from(this.readString(nestedOauthInfoB64Bytes), 'base64'),
      );
      return this.extractOAuthTokenDetailsFromOAuthInfo(nestedOauthInfoBytes);
    } catch {
      return null;
    }
  }
}
