import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS, fr, ru, tr, vi, zhCN } from 'date-fns/locale';

const locales: Partial<Record<string, Locale>> = { en: enUS, fr, ru, tr, vi, zh: zhCN };

export function formatAccountLastUsed(timestampSeconds: number, language = 'en'): string {
  return formatDistanceToNow(timestampSeconds * 1000, {
    addSuffix: true,
    locale: locales[language?.split('-')[0] ?? 'en'] ?? enUS,
  });
}
