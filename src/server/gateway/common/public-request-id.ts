/** Existing transport identity only; never forward an arbitrary header or construct another ID. */
export function publicProxyRequestId(request?: { id?: string }): string | undefined {
  const id = request?.id;
  return id && /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : undefined;
}
