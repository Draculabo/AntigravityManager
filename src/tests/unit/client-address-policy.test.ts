import { describe, expect, it } from 'vitest';
import {
  evaluateClientAddress,
  resolveClientAddress,
  type ClientAddressPolicy,
} from '@/shared/network/client-address';

const policy = (overrides: Partial<ClientAddressPolicy> = {}): ClientAddressPolicy => ({
  ip_filter_mode: 'off',
  ip_allowlist: [],
  ip_blocklist: [],
  allowlist_takes_precedence: true,
  trusted_proxy_cidrs: [],
  ...overrides,
});

describe('client address policy', () => {
  it('ignores forwarded headers from an untrusted peer', () => {
    expect(
      resolveClientAddress('192.0.2.10', {
        'x-forwarded-for': '198.51.100.8',
        'x-real-ip': '203.0.113.9',
      }),
    ).toBe('192.0.2.10');
  });

  it('uses configured trust instead of a caller-supplied trust header', () => {
    expect(
      resolveClientAddress(
        '192.0.2.10',
        { 'x-forwarded-for': '198.51.100.8', 'x-trusted-proxy-cidrs': '192.0.2.0/24' },
        [],
      ),
    ).toBe('192.0.2.10');
  });

  it('walks a trusted proxy chain from the service outward', () => {
    expect(
      resolveClientAddress(
        '10.0.0.5',
        {
          'x-forwarded-for': '198.51.100.20, 10.0.0.4',
        },
        ['10.0.0.0/8'],
      ),
    ).toBe('198.51.100.20');
  });

  it('rejects malformed or fully trusted forwarded chains', () => {
    expect(
      resolveClientAddress(
        '10.0.0.5',
        {
          'x-forwarded-for': 'not-an-ip, 10.0.0.4',
        },
        ['10.0.0.0/8'],
      ),
    ).toBeNull();
    expect(
      resolveClientAddress(
        '10.0.0.5',
        {
          'x-forwarded-for': '10.0.0.4',
        },
        ['10.0.0.0/8'],
      ),
    ).toBeNull();
  });

  it('normalizes mapped IPv4 before matching allowlist and blocklist entries', () => {
    expect(
      evaluateClientAddress(
        '::ffff:192.168.1.5',
        {},
        policy({
          ip_filter_mode: 'allowlist-and-blocklist',
          ip_allowlist: ['192.168.1.0/24'],
          ip_blocklist: ['192.168.1.0/25'],
          allowlist_takes_precedence: false,
        }),
      ),
    ).toEqual({
      allowed: false,
      clientAddress: '192.168.1.5',
      reason: 'blocked',
    });
  });

  it('allows an allowlisted address with precedence and rejects unknown sources', () => {
    const allowlistPolicy = policy({
      ip_filter_mode: 'allowlist-and-blocklist',
      ip_allowlist: ['2001:db8::/32'],
      ip_blocklist: ['2001:db8::/48'],
      allowlist_takes_precedence: true,
    });
    expect(evaluateClientAddress('2001:0db8::1', {}, allowlistPolicy)).toEqual({
      allowed: true,
      clientAddress: '2001:db8::1',
      reason: 'allowlist',
    });
    expect(evaluateClientAddress('2001:db9::1', {}, allowlistPolicy)).toEqual({
      allowed: false,
      clientAddress: '2001:db9::1',
      reason: 'not-allowlisted',
    });
  });
});
