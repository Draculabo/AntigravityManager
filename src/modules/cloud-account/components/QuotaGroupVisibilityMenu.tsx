import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { QuotaGroupVisibility } from '@/modules/cloud-account/utils/quota-group-visibility';

interface QuotaGroupVisibilityMenuProps {
  value: QuotaGroupVisibility;
  onChange(value: QuotaGroupVisibility): void;
}

export function QuotaGroupVisibilityMenu({ value, onChange }: QuotaGroupVisibilityMenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Eye className="mr-1 h-4 w-4" />
          {t('cloud.quota-display.title')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {(['fiveHour', 'weekly'] as const).map((window) => (
          <div key={window}>
            <DropdownMenuLabel>
              {t(
                window === 'fiveHour'
                  ? 'cloud.quota-window.five-hours'
                  : 'cloud.quota-window.weekly',
              )}
            </DropdownMenuLabel>
            {(['gemini', 'claude'] as const).map((family) => (
              <DropdownMenuCheckboxItem
                key={family}
                checked={value[window][family]}
                aria-label={t(
                  `cloud.quota-display.${window === 'fiveHour' ? 'five-hours' : 'weekly'}-${family}`,
                )}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  onChange({ ...value, [window]: { ...value[window], [family]: checked } })
                }
              >
                {family === 'gemini' ? 'Gemini' : 'Claude'}
              </DropdownMenuCheckboxItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <p className="text-muted-foreground px-2 py-1 text-xs">
          {t('cloud.quota-display.description')}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
