import { describe, expect, it } from 'vitest';
import { getTrayTexts } from '@/modules/app-shell/ipc/tray/i18n';
import { getTrayQuotaText } from '@/modules/app-shell/ipc/tray/quota';

function modelQuota(percentage: number) {
  return { percentage, resetTime: '2026-11-12T00:00:00.000Z' };
}

describe('getTrayQuotaText', () => {
  const texts = getTrayTexts('en');

  it('renders the minimum reported quota per group in a stable order', () => {
    const models = {
      'claude-sonnet-4-6-thinking': modelQuota(70),
      'gemini-3.8-flash-high': modelQuota(60),
      'models/gemini-3.1-pro-low': modelQuota(35),
      'gemini-pro-agent': modelQuota(80),
      'gemini-3.1-flash-image': modelQuota(95),
      'gemini-3-pro-image-preview': modelQuota(45),
      'gemini-3.6-flash-low': modelQuota(25),
      'claude-opus-4-6': modelQuota(15),
      'claude-sonnet': modelQuota(12),
      'vendor-high-image-claude': modelQuota(1),
    };
    const expected = ['Gemini Pro: 35%', 'Gemini Flash: 25%', 'Gemini Image: 45%', 'Claude: 12%'];

    expect(getTrayQuotaText({ quota: { models } }, texts)).toEqual(expected);
    expect(
      getTrayQuotaText(
        { quota: { models: Object.fromEntries(Object.entries(models).reverse()) } },
        texts,
      ),
    ).toEqual(expected);
  });

  it('shows a reported zero without inventing quota for absent groups', () => {
    expect(
      getTrayQuotaText({ quota: { models: { 'gemini-3.1-pro-high': modelQuota(0) } } }, texts),
    ).toEqual(['Gemini Pro: 0%']);
  });

  it('includes Gemini 3 Pro observations from older account catalogs', () => {
    const models = {
      'gemini-3-pro-preview': modelQuota(30),
      'gemini-3-pro-high': modelQuota(65),
    };

    expect(getTrayQuotaText({ quota: { models } }, texts)).toEqual(['Gemini Pro: 30%']);
  });

  it('shows unknown quota when there are no observations for a tray group', () => {
    expect(getTrayQuotaText(null, texts)).toEqual(['Quota: Unknown']);
    expect(getTrayQuotaText({}, texts)).toEqual(['Quota: Unknown']);
    expect(getTrayQuotaText({ quota: { models: {} } }, texts)).toEqual(['Quota: Unknown']);
    expect(
      getTrayQuotaText({ quota: { models: { 'gpt-oss-120b': modelQuota(0) } } }, texts),
    ).toEqual(['Quota: Unknown']);
  });

  it('shows the localized forbidden state ahead of stored model values', () => {
    const quota = { is_forbidden: true, models: { 'gemini-3.1-pro-high': modelQuota(90) } };

    expect(getTrayQuotaText({ quota }, getTrayTexts('zh-CN'))).toEqual(['当前额度: 账号已被禁用']);
  });
});
