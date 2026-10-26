import { BlockList, isIP } from 'node:net';

export type ClientAddressDecision =
  | { allowed: true; clientAddress: string; reason: 'disabled' | 'allowlist' | 'not-blocked' }
  | {
      allowed: false;
      clientAddress: string | null;
      reason: 'invalid-source' | 'invalid-policy' | 'not-allowlisted' | 'blocked';
    };

export interface ClientAddressPolicy {
  ip_filter_mode: 'off' | 'allowlist' | 'blocklist' | 'allowlist-and-blocklist';
  ip_allowlist: string[];
  ip_blocklist: string[];
  allowlist_takes_precedence: boolean;
  trusted_proxy_cidrs: string[];
}

export function normalizeClientAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const candidate = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  const family = isIP(candidate);
  if (family === 4) {
    return candidate;
  }
  if (family !== 6 || candidate.includes('%')) {
    return null;
  }
  const canonical = new URL(`http://[${candidate}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  }
  return canonical;
}

function parseNetwork(value: string): { address: string; prefix: number } | null {
  const [addressPart, prefixPart, ...rest] = value.trim().split('/');
  if (!addressPart || rest.length > 0) {
    return null;
  }
  // Persisted rules accept only a bare IP or CIDR, never brackets, ports or zone IDs.
  if (isIP(addressPart) === 0 || addressPart.includes('%')) {
    return null;
  }
  const address = normalizeClientAddress(addressPart);
  if (!address) {
    return null;
  }
  const family = isIP(address);
  const maximum = family === 4 ? 32 : 128;
  if (prefixPart !== undefined && !/^(0|[1-9]\d{0,2})$/u.test(prefixPart)) {
    return null;
  }
  let prefix = prefixPart === undefined ? maximum : Number(prefixPart);
  if (isIP(addressPart) === 6 && family === 4 && prefixPart !== undefined) {
    if (prefix < 96 || prefix > 128) {
      return null;
    }
    prefix -= 96;
  }
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
    return null;
  }
  return { address, prefix };
}

export function validateClientAddressPolicy(policy: ClientAddressPolicy): string[] {
  const invalid = [
    ...policy.ip_allowlist,
    ...policy.ip_blocklist,
    ...policy.trusted_proxy_cidrs,
  ].filter((value) => parseNetwork(value) === null);
  return [...new Set(invalid)];
}

function matchesNetwork(address: string, network: string): boolean {
  const parsed = parseNetwork(network);
  if (!parsed || isIP(address) !== isIP(parsed.address)) {
    return false;
  }
  const blockList = new BlockList();
  blockList.addSubnet(parsed.address, parsed.prefix, isIP(parsed.address) === 4 ? 'ipv4' : 'ipv6');
  return blockList.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
}

function resolveTrustedChain(
  connectionAddress: string,
  forwardedFor: string | string[] | undefined,
  trustedProxyCidrs: string[],
): string | null {
  if (
    !trustedProxyCidrs.some((network) => matchesNetwork(connectionAddress, network))
  ) {
    return connectionAddress;
  }
  if (forwardedFor === undefined) {
    return connectionAddress;
  }
  if (typeof forwardedFor !== 'string' || forwardedFor.length > 4096) {
    return null;
  }
  const hops = forwardedFor.split(',');
  if (hops.length > 32 || hops.length === 0) {
    return null;
  }
  const normalized = hops.map(normalizeClientAddress);
  if (normalized.some((hop) => hop === null)) {
    return null;
  }
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const hop = normalized[index];
    if (hop && !trustedProxyCidrs.some((network) => matchesNetwork(hop, network))) {
      return hop;
    }
  }
  return null;
}

export function resolveClientAddress(
  connectionAddress: string,
  headers: Record<string, string | string[] | undefined>,
  trustedProxyCidrs: string[] = [],
): string | null {
  const connection = normalizeClientAddress(connectionAddress);
  if (!connection) {
    return null;
  }
  if (trustedProxyCidrs.some((network) => parseNetwork(network) === null)) {
    return null;
  }
  return resolveTrustedChain(connection, headers['x-forwarded-for'], trustedProxyCidrs);
}

export function evaluateClientAddress(
  connectionAddress: string,
  headers: Record<string, string | string[] | undefined>,
  policy: ClientAddressPolicy,
): ClientAddressDecision {
  if (validateClientAddressPolicy(policy).length > 0) {
    return { allowed: false, clientAddress: null, reason: 'invalid-policy' };
  }
  const clientAddress = resolveClientAddress(connectionAddress, headers, policy.trusted_proxy_cidrs);
  if (!clientAddress) {
    return { allowed: false, clientAddress: null, reason: 'invalid-source' };
  }
  if (policy.ip_filter_mode === 'off') {
    return { allowed: true, clientAddress, reason: 'disabled' };
  }
  const allowlisted = policy.ip_allowlist.some((network) => matchesNetwork(clientAddress, network));
  const blocked = policy.ip_blocklist.some((network) => matchesNetwork(clientAddress, network));
  const usesAllowlist =
    policy.ip_filter_mode === 'allowlist' ||
    policy.ip_filter_mode === 'allowlist-and-blocklist';
  const usesBlocklist =
    policy.ip_filter_mode === 'blocklist' ||
    policy.ip_filter_mode === 'allowlist-and-blocklist';
  if (usesAllowlist && allowlisted && policy.allowlist_takes_precedence) {
    return { allowed: true, clientAddress, reason: 'allowlist' };
  }
  if (usesBlocklist && blocked) {
    return { allowed: false, clientAddress, reason: 'blocked' };
  }
  if (usesAllowlist && !allowlisted) {
    return { allowed: false, clientAddress, reason: 'not-allowlisted' };
  }
  return {
    allowed: true,
    clientAddress,
    reason: usesAllowlist && allowlisted ? 'allowlist' : 'not-blocked',
  };
}
