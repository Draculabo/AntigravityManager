import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ModelAliasRoute } from '@/modules/config/types';
import { isModelAliasPublished } from '@/modules/config/model-aliases';

const AUTOMATIC_TARGETS = [
  { id: 'auto:gemini-flash-low', label: 'auto-flash', description: 'auto-flash-description' },
  { id: 'auto:claude-opus', label: 'auto-opus', description: 'auto-opus-description' },
  {
    id: 'auto:claude-opus-4-7',
    label: 'auto-opus-compat',
    description: 'auto-opus-compat-description',
  },
] as const;

export function ModelAliasEditor({
  routes,
  onSave,
}: {
  routes: ModelAliasRoute[];
  onSave(routes: ModelAliasRoute[]): Promise<void>;
}) {
  const { t } = useTranslation();
  const scopeId = useId();
  const [draft, setDraft] = useState<ModelAliasRoute[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const values = draft ?? routes;
  const normalized = values.map((route) => ({
    ...route,
    alias: route.alias.trim(),
    target: route.target.trim(),
  }));
  const invalid =
    normalized.some((route) => !route.alias || !route.target) ||
    new Set(normalized.map((route) => route.alias)).size !== normalized.length;
  const edit = (next: ModelAliasRoute[]) => {
    setDraft(next);
    setFailed(false);
    setSaved(false);
  };
  const update = (index: number, patch: Partial<ModelAliasRoute>) => {
    edit(values.map((route, position) => (position === index ? { ...route, ...patch } : route)));
  };

  return (
    <form
      className="space-y-4 border-t pt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (invalid || saving || draft === null) {
          return;
        }
        setSaving(true);
        setFailed(false);
        try {
          await onSave(normalized);
          setDraft(null);
          setSaved(true);
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t('proxy.mapping.alias-rules')}</h3>
        <p className="text-muted-foreground text-sm">
          {t('proxy.mapping.alias-rules-description')}
        </p>
      </div>
      <fieldset disabled={saving} className="min-w-0 space-y-3">
        {values.length === 0 && (
          <p className="text-muted-foreground text-sm">{t('proxy.mapping.no-rules')}</p>
        )}
        {values.map((route, index) => {
          const prefix = `${scopeId}-${index}`;
          const automatic = AUTOMATIC_TARGETS.find((target) => target.id === route.target);
          const wildcard =
            route.alias.includes('*') || route.alias.toLowerCase().startsWith('auto:');
          return (
            <div key={index} className="space-y-3 rounded-md border p-3">
              <div className="grid items-end gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`${prefix}-alias`}>{t('proxy.mapping.requested-model')}</Label>
                  <Input
                    id={`${prefix}-alias`}
                    value={route.alias}
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => update(index, { alias: event.target.value })}
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`${prefix}-target`}>{t('proxy.mapping.target-model')}</Label>
                  <Input
                    id={`${prefix}-target`}
                    value={route.target}
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={automatic ? `${prefix}-strategy` : undefined}
                    onChange={(event) => update(index, { target: event.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-strategy-select`}>
                  {t('proxy.mapping.routing-strategy')}
                </Label>
                <Select
                  value={automatic?.id ?? 'fixed'}
                  onValueChange={(target) => {
                    update(index, {
                      target: target === 'fixed' ? '' : target,
                      published: false,
                    });
                  }}
                >
                  <SelectTrigger id={`${prefix}-strategy-select`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">{t('proxy.mapping.fixed-target')}</SelectItem>
                    {AUTOMATIC_TARGETS.map((target) => (
                      <SelectItem key={target.id} value={target.id}>
                        {t(`proxy.mapping.${target.label}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {automatic && (
                  <p id={`${prefix}-strategy`} className="text-muted-foreground text-sm">
                    {t(`proxy.mapping.${automatic.description}`)}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={route.enabled}
                    onCheckedChange={(checked) => update(index, { enabled: checked === true })}
                  />
                  {t('proxy.mapping.route-enabled')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={isModelAliasPublished(route)}
                    disabled={wildcard}
                    onCheckedChange={(checked) => update(index, { published: checked === true })}
                  />
                  {t('proxy.mapping.published')}
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive sm:ml-auto"
                  aria-label={t('proxy.mapping.remove-rule', { index: index + 1 })}
                  onClick={() => edit(values.filter((_, position) => position !== index))}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
              {wildcard && (
                <p className="text-muted-foreground text-xs">{t('proxy.mapping.pattern-hidden')}</p>
              )}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={values.length >= 256}
            onClick={() => edit([...values, { alias: '', target: '', enabled: true }])}
          >
            <Plus aria-hidden="true" />
            {t('proxy.mapping.add-rule')}
          </Button>
          <Button type="submit" disabled={invalid || draft === null}>
            {t(saving ? 'proxy.mapping.saving-rules' : 'proxy.mapping.save-rules')}
          </Button>
          {draft !== null && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setFailed(false);
              }}
            >
              {t('proxy.mapping.discard-rules')}
            </Button>
          )}
        </div>
      </fieldset>
      {invalid && draft !== null && (
        <p role="alert" className="text-destructive text-sm">
          {t('proxy.mapping.invalid-rules')}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-destructive text-sm">
          {t('proxy.mapping.save-failed')}
        </p>
      )}
      {saved && (
        <p role="status" className="text-muted-foreground text-sm">
          {t('proxy.mapping.rules-saved')}
        </p>
      )}
    </form>
  );
}
