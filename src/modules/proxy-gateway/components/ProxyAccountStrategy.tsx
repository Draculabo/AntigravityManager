import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';

type AccountStrategy = ServiceConfigSnapshot['proxy']['account_selection_strategy'];
interface ProxyAccountStrategyProps {
  value: AccountStrategy;
  onChange(value: AccountStrategy): Promise<void>;
}

export function ProxyAccountStrategy({ value, onChange }: ProxyAccountStrategyProps) {
  const { t } = useTranslation();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const save = async (next: string) => {
    if (next !== 'balanced' && next !== 'account-first') {
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await onChange(next);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <Label htmlFor={id}>{t('proxy.account-strategy.title')}</Label>
      <Select
        value={value}
        disabled={saving}
        onValueChange={(next) => {
          void save(next);
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="balanced">{t('proxy.account-strategy.balanced')}</SelectItem>
          <SelectItem value="account-first">{t('proxy.account-strategy.account-first')}</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">
        {t(
          value === 'account-first'
            ? 'proxy.account-strategy.account-first-description'
            : 'proxy.account-strategy.balanced-description',
        )}
      </p>
      <p className="text-muted-foreground text-xs">
        {t('proxy.account-strategy.client-description')}
      </p>
      {failed && (
        <p role="alert" className="text-destructive text-xs">
          {t('proxy.account-strategy.save-failed')}
        </p>
      )}
    </div>
  );
}
