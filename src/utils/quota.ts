import { logger } from './logger';
import { CloudQuotaData } from '../types/cloudAccount';

/**
 * Calculates the average quota percentage across all models.
 * @param quota The quota data to calculate from
 * @returns The average percentage (0-100), or 0 if no models are present
 */
export function calculateAverageQuota(quota?: CloudQuotaData): number {
  if (!quota || !quota.models) {
    return 0;
  }

  const values = Object.values(quota.models).map((m) => m.percentage);

  if (values.length === 0) {
    logger.warn('QuotaUtils: No quota models available in data');
    return 0;
  }

  const sum = values.reduce((a, b) => a + b, 0);
  return sum / values.length;
}

/**
 * Checks if an account is considered depleted based on a threshold.
 * @param quota The quota data to check
 * @param threshold The threshold percentage (default 5%)
 * @returns true if depleted or missing data
 */
export function isQuotaDepleted(quota?: CloudQuotaData, threshold = 5): boolean {
  if (!quota || !quota.models || Object.keys(quota.models).length === 0) {
    return true; // Consider missing data as depleted to trigger sync/switch
  }

  const avg = calculateAverageQuota(quota);
  return avg < threshold;
}

/**
 * Formats quota data into displayable lines for UI (e.g. Tray).
 * @param quota The quota data to format
 * @param texts i18n texts for labels
 * @returns Array of formatted strings
 */
export function getQuotaDisplayLines(quota?: CloudQuotaData, texts?: any): string[] {
  if (!quota || !quota.models) {
    return [texts?.unknown_quota || 'Quota: Unknown'];
  }

  const lines: string[] = [];
  const models = quota.models;

  // Track if we found any of our "core" models
  let foundCore = false;

  for (const [name, info] of Object.entries(models)) {
    const lowerName = name.toLowerCase();
    let displayName = name;

    // Friendly names for common models
    if (lowerName.includes('high')) displayName = 'Gemini High';
    else if (lowerName.includes('image')) displayName = 'Gemini Image';
    else if (lowerName.includes('claude')) displayName = 'Claude 4.5';

    if (lowerName.includes('gemini') || lowerName.includes('claude')) {
      lines.push(`${displayName}: ${info.percentage}%`);
      foundCore = true;
    }
  }

  if (!foundCore && Object.keys(models).length > 0) {
    // Fallback if no gemini/claude models found but other models exist
    for (const [name, info] of Object.entries(models)) {
      lines.push(`${name}: ${info.percentage}%`);
    }
  }

  return lines.length > 0 ? lines : [texts?.no_models || 'No models available'];
}

