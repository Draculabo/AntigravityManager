import { describe, it, expect } from 'vitest';
import {
  detectProvider,
  getProviderInfo,
  calculateProviderStats,
  groupModelsByProvider,
} from '@/modules/cloud-account/utils/provider-grouping';

describe('detectProvider', () => {
  it('should categorize Claude models correctly', () => {
    expect(detectProvider('claude-3-7-sonnet')).toBe('claude-');
    expect(detectProvider('claude-2.1')).toBe('claude-');
    expect(detectProvider('claude-3-5-sonnet')).toBe('claude-');
    expect(detectProvider('claude-3-opus')).toBe('claude-');
    expect(detectProvider('claude-3-haiku')).toBe('claude-');
  });

  it('should categorize Gemini models correctly', () => {
    expect(detectProvider('gemini-2.0-flash')).toBe('gemini-');
    expect(detectProvider('gemini-1.5-pro')).toBe('gemini-');
    expect(detectProvider('gemini-2.5-flash')).toBe('gemini-');
  });

  it('should fallback to others for unknown models', () => {
    expect(detectProvider('gpt-4-turbo')).toBe('others');
    expect(detectProvider('llama-2-7b')).toBe('others');
    expect(detectProvider('unknown-model')).toBe('others');
  });

  it('should handle empty string', () => {
    expect(detectProvider('')).toBe('others');
  });
});

describe('getProviderInfo', () => {
  it('should return Claude info for Claude models', () => {
    const info = getProviderInfo('claude-3-7-sonnet');
    expect(info.name).toBe('Claude');
    expect(info.company).toBe('Anthropic');
  });

  it('should return Gemini info for Gemini models', () => {
    const info = getProviderInfo('gemini-2.0-flash');
    expect(info.name).toBe('Gemini');
    expect(info.company).toBe('Google');
  });

  it('should return Other info for unknown models', () => {
    const info = getProviderInfo('gpt-4');
    expect(info.name).toBe('Other');
    expect(info.company).toBe('Various');
  });
});

describe('calculateProviderStats', () => {
  it('should calculate correct averages for visible models', () => {
    const models = [
      { id: 'claude-3-7-sonnet', percentage: 80, resetTime: '2026-02-16T10:00:00Z' },
      { id: 'claude-3-5-sonnet', percentage: 70, resetTime: '2026-02-16T08:00:00Z' },
    ];
    const stats = calculateProviderStats('claude-', models, {});
    expect(stats.avgPercentage).toBe(75);
    expect(stats.visibleModels).toHaveLength(2);
    expect(stats.providerInfo.name).toBe('Claude');
  });

  it('should exclude hidden models from calculations', () => {
    const models = [
      { id: 'claude-3-7-sonnet', percentage: 80, resetTime: '2026-02-16T10:00:00Z' },
      { id: 'claude-3-5-sonnet', percentage: 40, resetTime: '2026-02-16T08:00:00Z' },
    ];
    const visibility = { 'claude-3-5-sonnet': false };
    const stats = calculateProviderStats('claude-', models, visibility);
    expect(stats.avgPercentage).toBe(80);
    expect(stats.visibleModels).toHaveLength(1);
    expect(stats.models).toHaveLength(2);
  });

  it('should find the earliest reset time', () => {
    const models = [
      { id: 'claude-3-7-sonnet', percentage: 80, resetTime: '2026-02-16T10:00:00Z' },
      { id: 'claude-3-5-sonnet', percentage: 70, resetTime: '2026-02-16T08:00:00Z' },
    ];
    const stats = calculateProviderStats('claude-', models, {});
    expect(stats.earliestReset).toBe('2026-02-16T08:00:00.000Z');
  });

  it('should handle empty models', () => {
    const stats = calculateProviderStats('claude-', [], {});
    expect(stats.avgPercentage).toBe(0);
    expect(stats.visibleModels).toHaveLength(0);
    expect(stats.earliestReset).toBeNull();
  });

  it('should handle all models hidden', () => {
    const models = [{ id: 'claude-3-7-sonnet', percentage: 80, resetTime: '2026-02-16T10:00:00Z' }];
    const visibility = { 'claude-3-7-sonnet': false };
    const stats = calculateProviderStats('claude-', models, visibility);
    expect(stats.avgPercentage).toBe(0);
    expect(stats.visibleModels).toHaveLength(0);
  });
});

describe('groupModelsByProvider', () => {
  it('should group models by provider', () => {
    const models = {
      'claude-3-7-sonnet': { percentage: 80, resetTime: '2026-02-16T10:00:00Z' },
      'claude-3-5-sonnet': { percentage: 70, resetTime: '2026-02-16T08:00:00Z' },
      'gemini-2.0-flash': { percentage: 50, resetTime: '2026-02-16T06:00:00Z' },
      'gemini-1.5-pro': { percentage: 30, resetTime: '2026-02-16T07:00:00Z' },
    };
    const stats = groupModelsByProvider(models, {});
    expect(stats.providers).toHaveLength(2);
    expect(stats.providers[0].providerKey).toBe('claude-');
    expect(stats.providers[0].visibleModels).toHaveLength(2);
    expect(stats.providers[1].providerKey).toBe('gemini-');
    expect(stats.providers[1].visibleModels).toHaveLength(2);
  });

  it('should include others group for unknown models', () => {
    const models = {
      'claude-3-7-sonnet': { percentage: 80, resetTime: '2026-02-16T10:00:00Z' },
      'gpt-4-turbo': { percentage: 60, resetTime: '2026-02-16T09:00:00Z' },
    };
    const stats = groupModelsByProvider(models, {});
    expect(stats.providers).toHaveLength(2);
    expect(stats.providers[1].providerKey).toBe('others');
  });

  it('should calculate overall percentage as average of all visible models', () => {
    const models = {
      'claude-3-7-sonnet': { percentage: 80, resetTime: '' },
      'gemini-2.0-flash': { percentage: 40, resetTime: '' },
    };
    const stats = groupModelsByProvider(models, {});
    expect(stats.overallPercentage).toBe(60);
    expect(stats.visibleModels).toBe(2);
    expect(stats.totalModels).toBe(2);
  });

  it('should determine health status based on overall percentage', () => {
    // healthy (>=50%)
    const healthyModels = {
      'claude-3-7-sonnet': { percentage: 80, resetTime: '' },
    };
    expect(groupModelsByProvider(healthyModels, {}).healthStatus).toBe('healthy');

    // degraded (25-50%)
    const degradedModels = {
      'claude-3-7-sonnet': { percentage: 40, resetTime: '' },
    };
    expect(groupModelsByProvider(degradedModels, {}).healthStatus).toBe('degraded');

    // limited (10-25%)
    const limitedModels = {
      'claude-3-7-sonnet': { percentage: 20, resetTime: '' },
    };
    expect(groupModelsByProvider(limitedModels, {}).healthStatus).toBe('limited');

    // critical (<10%)
    const criticalModels = {
      'claude-3-7-sonnet': { percentage: 5, resetTime: '' },
    };
    expect(groupModelsByProvider(criticalModels, {}).healthStatus).toBe('critical');
  });

  it('should handle empty models object', () => {
    const stats = groupModelsByProvider({}, {});
    expect(stats.providers).toHaveLength(0);
    expect(stats.overallPercentage).toBe(0);
    expect(stats.totalModels).toBe(0);
    expect(stats.visibleModels).toBe(0);
  });

  it('should respect model visibility settings', () => {
    const models = {
      'claude-3-7-sonnet': { percentage: 80, resetTime: '' },
      'claude-3-5-sonnet': { percentage: 40, resetTime: '' },
    };
    const visibility = { 'claude-3-5-sonnet': false };
    const stats = groupModelsByProvider(models, visibility);
    expect(stats.visibleModels).toBe(1);
    expect(stats.overallPercentage).toBe(80);
  });

  it('uses the conservative family quota instead of averaging routed variants', () => {
    const models = {
      'gemini-3.1-pro-low': { percentage: 80, resetTime: '2026-07-30T10:00:00Z' },
      'gemini-pro-agent': { percentage: 5, resetTime: '2026-07-30T08:00:00Z' },
    };

    const stats = groupModelsByProvider(models, {
      'gemini-3.1-pro-low': false,
    });

    expect(stats.visibleModels).toBe(1);
    expect(stats.overallPercentage).toBe(5);
    expect(stats.providers[0].earliestReset).toBe('2026-07-30T08:00:00.000Z');
  });

  it('should sort providers: claude first, gemini second, others last', () => {
    const models = {
      'gpt-4': { percentage: 50, resetTime: '' },
      'gemini-2.0-flash': { percentage: 60, resetTime: '' },
      'claude-3-7-sonnet': { percentage: 70, resetTime: '' },
    };
    const stats = groupModelsByProvider(models, {});
    expect(stats.providers[0].providerKey).toBe('claude-');
    expect(stats.providers[1].providerKey).toBe('gemini-');
    expect(stats.providers[2].providerKey).toBe('others');
  });
});
