import { useTranslation } from 'react-i18next';
import type { GlobalSystemPromptConfig } from '@/modules/config/types';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

interface GlobalSystemPromptCardProps {
  config: GlobalSystemPromptConfig;
  onChange: (config: GlobalSystemPromptConfig) => void;
}

export function GlobalSystemPromptCard({ config, onChange }: GlobalSystemPromptCardProps) {
  const { t } = useTranslation();
  const characterCount = config.content.length;

  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-labelledby="global-system-prompt-title"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label id="global-system-prompt-title" htmlFor="global-system-prompt-enabled">
            {t('proxy.config.global-system-prompt-title')}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t('proxy.config.global-system-prompt-description')}
          </p>
        </div>
        <Switch
          id="global-system-prompt-enabled"
          checked={config.enabled}
          onCheckedChange={(enabled) => onChange({ ...config, enabled })}
        />
      </div>

      {config.enabled && (
        <div className="space-y-2">
          <textarea
            id="global-system-prompt-content"
            value={config.content}
            onChange={(event) => onChange({ ...config, content: event.target.value })}
            placeholder={t('proxy.config.global-system-prompt-placeholder')}
            rows={6}
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-36 w-full resize-y rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">
              {t('proxy.config.global-system-prompt-character-count', { count: characterCount })}
            </p>
            {characterCount > 2000 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {t('proxy.config.global-system-prompt-long-warning')}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
