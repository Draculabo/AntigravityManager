import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG, ProxyConfigSchema } from '@/modules/config/types';
import { ServiceConfigUpdateSchema } from '@/modules/config/service-config.schema';

it('loads a legacy transport timeout without keeping generation at its old 120-second limit', () => {
  const { generation_timeout: _generation, ...legacy } = DEFAULT_APP_CONFIG.proxy;
  const loaded = ProxyConfigSchema.parse({ ...legacy, request_timeout: 120 });
  expect(loaded).toMatchObject({ request_timeout: 120, generation_timeout: 270 });
});

it('preserves custom generation limits when a management patch omits that field', () => {
  const current = { ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 75 };
  const patch = ServiceConfigUpdateSchema.parse({ proxy: { port: 8046 } });
  expect(ProxyConfigSchema.parse({ ...current, ...patch.proxy })).toMatchObject({
    port: 8046,
    generation_timeout: 75,
  });
  expect(ServiceConfigUpdateSchema.parse({ proxy: { generation_timeout: 90 } })).toEqual({
    proxy: { generation_timeout: 90 },
  });
});

describe.each([0, -1, 0.5, Infinity, 3601])(
  'invalid generation budget %s',
  (generation_timeout) => {
    it('rejects the value at durable and management boundaries', () => {
      expect(
        ProxyConfigSchema.safeParse({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout }).success,
      ).toBe(false);
      expect(ServiceConfigUpdateSchema.safeParse({ proxy: { generation_timeout } }).success).toBe(
        false,
      );
    });
  },
);
