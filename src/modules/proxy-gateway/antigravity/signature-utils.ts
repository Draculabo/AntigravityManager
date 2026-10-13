/**
 * Signatures are opaque protocol values, including Base64-encoded binary data.
 * Printable UTF-8 bytes do not establish a text encoding; preserve every non-empty value.
 */
export function readThoughtSignature(signature: string | undefined | null): string | undefined {
  return signature || undefined;
}
