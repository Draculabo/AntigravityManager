import { min } from 'lodash-es';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { aggregateQuotaModelFamilies } from '@/modules/cloud-account/utils/quota-model-families';
import type { TrayTexts } from './i18n';

const proFamilies = new Set([
  'gemini-3.1-pro',
  'gemini-3-pro',
  'gemini-3-pro-preview',
  'gemini-3-pro-high',
  'gemini-3-pro-low',
]);

const flashFamilies = new Set([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-flash-lite',
]);

const trayQuotaGroups = [
  { label: 'Gemini Pro', matches: (familyId: string) => proFamilies.has(familyId) },
  { label: 'Gemini Flash', matches: (familyId: string) => flashFamilies.has(familyId) },
  {
    label: 'Gemini Image',
    matches: (familyId: string) =>
      familyId === 'gemini-pro-image' || familyId === 'gemini-flash-image',
  },
  {
    label: 'Claude',
    matches: (familyId: string) => /^claude-(sonnet|opus|haiku)(?:-\d+-\d+)?$/.test(familyId),
  },
];

export function getTrayQuotaText(
  account: Pick<CloudAccountView, 'quota'> | null,
  texts: TrayTexts,
): string[] {
  const quota = account?.quota;
  if (!quota) {
    return [`${texts.quota}: ${texts.unknown_quota}`];
  }
  if (quota.is_forbidden) {
    return [`${texts.quota}: ${texts.forbidden}`];
  }

  const families = Object.entries(aggregateQuotaModelFamilies(quota.models));
  const lines = trayQuotaGroups.flatMap(({ label, matches }) => {
    const percentage = min(
      families.filter(([familyId]) => matches(familyId)).map(([, family]) => family.percentage),
    );
    return percentage === undefined ? [] : [`${label}: ${percentage}%`];
  });

  return lines.length > 0 ? lines : [`${texts.quota}: ${texts.unknown_quota}`];
}
