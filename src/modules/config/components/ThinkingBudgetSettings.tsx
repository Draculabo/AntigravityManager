import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import {
  readServiceConfigErrorCode,
  GatewayThinkingBudgetPatchSchema,
  type ServiceConfigSnapshot,
  type ServiceConfigUpdate,
  type ServiceConfigWriteResult,
} from '../service-config.schema';

type ThinkingBudgetConfig = ServiceConfigSnapshot['proxy']['thinking_budget'];

const ADAPTIVE_SENTINEL = -1;
const BUDGET_MIN = -1;
const BUDGET_MAX = 131072;

/**
 * Gateway budget keys that map a model family/level to an explicit budget. A value of
 * Flash Low and Medium use their registered defaults for -1; other fields use adaptive thinking.
 * Zero is not a legal gateway budget.
 */
const GATEWAY_FIELDS = [
  { key: 'flash_low', level: 'low', family: 'flash' },
  { key: 'flash_medium', level: 'medium', family: 'flash' },
  { key: 'flash_high', level: 'high', family: 'flash' },
  { key: 'flash_tiered', level: 'tiered', family: 'flash' },
  { key: 'pro_low', level: 'low', family: 'pro' },
  { key: 'pro_high', level: 'high', family: 'pro' },
  { key: 'claude_budget', level: 'default', family: 'claude' },
  { key: 'claude_low', level: 'low', family: 'claude' },
  { key: 'claude_medium', level: 'medium', family: 'claude' },
  { key: 'claude_high', level: 'high', family: 'claude' },
] as const satisfies ReadonlyArray<{
  key: keyof ThinkingBudgetConfig;
  level: string;
  family: string;
}>;

/** Normalizes one draft field. Empty or partial input falls back to the adaptive sentinel. */
function normalizeBudgetDraft(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') {
    return ADAPTIVE_SENTINEL;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed === 0 || parsed < BUDGET_MIN || parsed > BUDGET_MAX) {
    return null;
  }
  return parsed;
}

function parseDraft(value: ThinkingBudgetConfig) {
  const drafts: Record<string, string> = { control_source: value.control_source };
  const invalid: string[] = [];
  for (const field of GATEWAY_FIELDS) {
    const current = value[field.key];
    drafts[field.key] = String(current);
    if (
      !Number.isSafeInteger(current) ||
      current === 0 ||
      current < BUDGET_MIN ||
      current > BUDGET_MAX
    ) {
      invalid.push(field.key);
    }
  }
  return { drafts, invalid };
}

interface ThinkingBudgetSettingsProps {
  config: ThinkingBudgetConfig;
  available: boolean;
  onSaved(): Promise<void>;
  onApplicationResult?(result: ServiceConfigWriteResult): void;
}

export function ThinkingBudgetSettings({
  config,
  available,
  onSaved,
  onApplicationResult,
}: ThinkingBudgetSettingsProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const initial = useMemo(() => parseDraft(config), [config]);
  const [drafts, setDrafts] = useState<Record<string, string>>(initial.drafts);
  const baseline = useRef({ ...initial.drafts });
  const [invalid, setInvalid] = useState<string[]>(initial.invalid);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const reportFailure = (error: unknown) => {
    toast({
      error,
      title: t(
        readServiceConfigErrorCode(error) === 'invalid-input'
          ? 'settings.thinkingBudget.configuration-invalid'
          : 'settings.service-unavailable',
      ),
      variant: 'destructive',
    });
  };

  const save = async (change: ServiceConfigUpdate) => {
    if (pending.current) {
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      const result = await ipc.client.config.service.update(change);
      onApplicationResult?.(result);
      await onSaved();
      if (result.state !== 'partial-failure') {
        for (const [key, value] of Object.entries(change.proxy?.thinking_budget ?? {})) {
          baseline.current[key] = String(value);
        }
      }
      toast({
        title:
          result.state === 'partial-failure'
            ? t('settings.service-apply-failed')
            : result.state === 'applied'
              ? t('settings.toast.saved.title')
              : t('settings.service-restart-required'),
        ...(result.state === 'partial-failure' ? { variant: 'destructive' as const } : {}),
      });
    } catch (error) {
      reportFailure(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const updateDraft = (key: string, next: string) => {
    setDrafts((previous) => ({ ...previous, [key]: next }));
    const normalized = normalizeBudgetDraft(next);
    setInvalid((previous) => {
      const has = previous.includes(key);
      if (normalized === null && !has) {
        return [...previous, key];
      }
      if (normalized !== null && has) {
        return previous.filter((item) => item !== key);
      }
      return previous;
    });
  };

  const saveAll = async () => {
    const patch: Record<string, number | string> = {};
    const source = drafts.control_source ?? config.control_source;
    for (const field of source === 'gateway' ? GATEWAY_FIELDS : []) {
      const normalized = normalizeBudgetDraft(drafts[field.key] ?? '');
      if (normalized === null) {
        setInvalid((previous) =>
          previous.includes(field.key) ? previous : [...previous, field.key],
        );
        return;
      }
      if (normalized !== Number(baseline.current[field.key])) {
        patch[field.key] = normalized;
      }
    }
    if (source !== baseline.current.control_source) {
      patch.control_source = source;
    }
    if (Object.keys(patch).length === 0) {
      return;
    }
    const parsed = GatewayThinkingBudgetPatchSchema.safeParse(patch);
    if (!parsed.success) {
      setInvalid(GATEWAY_FIELDS.map((field) => field.key));
      return;
    }
    await save({ proxy: { thinking_budget: parsed.data } });
  };

  const controlSource = drafts.control_source ?? config.control_source;
  const hasInvalid = controlSource === 'gateway' && invalid.length > 0;

  return (
    <Card className="shadow-none">
      <CardHeader className="p-4">
        <CardTitle>{t('settings.thinkingBudget.title')}</CardTitle>
        <CardDescription>{t('settings.thinkingBudget.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 p-4 pt-0">
        <div className="grid gap-2 sm:grid-cols-[1fr_200px] sm:items-center">
          <div className="space-y-1">
            <Label htmlFor="thinking-budget-control-source">
              {t('settings.thinkingBudget.controlSource')}
            </Label>
            <p className="text-muted-foreground text-xs">
              {t('settings.thinkingBudget.controlSourceHint')}
            </p>
          </div>
          <Select
            value={controlSource}
            disabled={!available || busy}
            onValueChange={(next) => {
              setDrafts((previous) => ({ ...previous, control_source: next }));
            }}
          >
            <SelectTrigger id="thinking-budget-control-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gateway">{t('settings.thinkingBudget.source.gateway')}</SelectItem>
              <SelectItem value="client">{t('settings.thinkingBudget.source.client')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {controlSource === 'gateway' ? (
          <fieldset disabled={!available || busy} className="space-y-5">
            <p className="text-muted-foreground text-sm">
              {t('settings.thinkingBudget.gatewayHint')}
            </p>
            {(['flash', 'pro', 'claude'] as const).map((family) => (
              <div key={family} className="space-y-3 rounded-lg border p-4">
                <Label className="text-sm font-medium">
                  {t(`settings.thinkingBudget.family.${family}`)}
                </Label>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {GATEWAY_FIELDS.filter((field) => field.family === family).map((field) => {
                    const fieldInvalid = invalid.includes(field.key);
                    return (
                      <div key={field.key} className="space-y-1">
                        <Label htmlFor={`thinking-budget-${field.key}`} className="text-xs">
                          {t(`settings.thinkingBudget.level.${field.level}`)}
                        </Label>
                        <Input
                          id={`thinking-budget-${field.key}`}
                          type="number"
                          min={BUDGET_MIN}
                          max={BUDGET_MAX}
                          value={drafts[field.key] ?? ''}
                          aria-invalid={fieldInvalid}
                          aria-describedby={`thinking-budget-${field.key}-hint`}
                          onChange={(event) => updateDraft(field.key, event.currentTarget.value)}
                        />
                        <p
                          id={`thinking-budget-${field.key}-hint`}
                          className={
                            fieldInvalid
                              ? 'text-destructive text-xs'
                              : 'text-muted-foreground text-xs'
                          }
                          role={fieldInvalid ? 'alert' : undefined}
                        >
                          {fieldInvalid
                            ? t('settings.thinkingBudget.invalid')
                            : field.key === 'flash_low'
                              ? t('settings.thinkingBudget.flash-low-default-hint')
                              : field.key === 'flash_medium'
                                ? t('settings.thinkingBudget.flash-medium-default-hint')
                                : t('settings.thinkingBudget.adaptiveHint')}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </fieldset>
        ) : (
          <p className="text-muted-foreground text-sm">{t('settings.thinkingBudget.clientHint')}</p>
        )}
        <div className="flex items-center gap-3">
          <Button disabled={!available || busy || hasInvalid} onClick={() => void saveAll()}>
            {busy ? t('settings.service-save') + '…' : t('settings.service-save')}
          </Button>
          {hasInvalid ? (
            <p className="text-destructive text-sm" role="alert">
              {t('settings.thinkingBudget.invalid')}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
