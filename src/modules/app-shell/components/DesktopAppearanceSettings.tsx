import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DESKTOP_LANGUAGES,
  DESKTOP_ZOOM_LEVELS,
  isDesktopZoom,
  normalizeDesktopLanguage,
} from '../desktop-appearance';
import { useDesktopAppearance } from './DesktopAppearanceProvider';

const languageLabel = {
  en: 'english',
  'zh-CN': 'chinese',
  ru: 'russian',
  vi: 'vietnamese',
  tr: 'turkish',
  fr: 'french',
  'pt-BR': 'portuguese',
  ja: 'japanese',
} as const;

function PreferenceFeedback({
  status,
  onRetry,
}: {
  status: 'idle' | 'saving' | 'failed';
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (status === 'idle') {
    return null;
  }
  if (status === 'saving') {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t('settings.appearance-saving')}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <p role="alert">{t('settings.appearance-save-failed')}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('settings.appearance-retry')}
      </Button>
    </div>
  );
}

export function DesktopAppearanceSettings() {
  const { t, i18n } = useTranslation();
  const appearance = useDesktopAppearance();
  const percentage = new Intl.NumberFormat(normalizeDesktopLanguage(i18n.language), {
    style: 'percent',
  });
  return (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="language">{t('settings.language.title')}</Label>
            <p className="text-muted-foreground text-sm">{t('settings.language.description')}</p>
          </div>
          <Select
            disabled={!appearance.ready}
            value={appearance.language}
            onValueChange={(value) => appearance.setLanguage(normalizeDesktopLanguage(value))}
          >
            <SelectTrigger id="language" className="w-44 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DESKTOP_LANGUAGES.map((language) => (
                <SelectItem key={language} value={language}>
                  {t(`settings.language.${languageLabel[language]}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <PreferenceFeedback status={appearance.languageStatus} onRetry={appearance.retryLanguage} />
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label htmlFor="interface-zoom">{t('settings.interface-zoom')}</Label>
          <Select
            disabled={!appearance.ready}
            value={String(appearance.zoom)}
            onValueChange={(value) => {
              const zoom = Number(value);
              if (isDesktopZoom(zoom)) {
                appearance.setZoom(zoom);
              }
            }}
          >
            <SelectTrigger id="interface-zoom" className="w-44 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DESKTOP_ZOOM_LEVELS.map((zoom) => (
                <SelectItem key={zoom} value={String(zoom)}>
                  {percentage.format(zoom / 100)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <PreferenceFeedback status={appearance.zoomStatus} onRetry={appearance.retryZoom} />
      </div>
    </>
  );
}
