import { useMemo, useState } from 'react';
import { groupBy } from 'lodash-es';
import { Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ProxyExampleModel } from './proxy-example-models';
import type { OpenCodeModelInput } from '../opencode-sync/opencode-jsonc-config';
import {
  canonicalizeOpenCodeModelId,
  getOpenCodeModelDisplayName,
} from '../opencode-sync/opencode-model-normalization';

export interface OpenCodeSyncSelection {
  baseUrl: string;
  models: OpenCodeModelInput[];
  syncAccounts: boolean;
}

interface OpenCodeModelSyncDialogProps {
  availableModels: readonly ProxyExampleModel[];
  configuredModels: readonly OpenCodeModelInput[];
  initialBaseUrl: string;
  syncAccounts: boolean;
  onOpenChange: (open: boolean) => void;
  onSyncAccountsChange: (syncAccounts: boolean) => void;
  onSync: (selection: OpenCodeSyncSelection) => Promise<boolean>;
}

function getModelGroup(modelId: string): string {
  const normalizedId = modelId.toLowerCase();
  if (normalizedId.includes('claude')) {
    return 'Claude';
  }
  if (normalizedId.includes('image')) {
    return 'Gemini Image';
  }
  if (normalizedId.includes('gemini')) {
    return 'Gemini';
  }
  if (normalizedId.includes('gpt')) {
    return 'GPT';
  }
  return 'Dynamic';
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function OpenCodeModelSyncDialog({
  availableModels,
  configuredModels,
  initialBaseUrl,
  syncAccounts,
  onOpenChange,
  onSyncAccountsChange,
  onSync,
}: OpenCodeModelSyncDialogProps) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [selectedModelIds, setSelectedModelIds] = useState(
    () => new Set(configuredModels.map((model) => canonicalizeOpenCodeModelId(model.id))),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectableModels = useMemo(() => {
    const modelsById = new Map<string, ProxyExampleModel>();
    for (const model of availableModels) {
      const id = canonicalizeOpenCodeModelId(model.id);
      if (!modelsById.has(id)) {
        modelsById.set(id, {
          id,
          name: getOpenCodeModelDisplayName(id, model.name),
        });
      }
    }
    for (const configuredModel of configuredModels) {
      const id = canonicalizeOpenCodeModelId(configuredModel.id);
      if (!modelsById.has(id)) {
        modelsById.set(id, {
          id,
          name: getOpenCodeModelDisplayName(id, configuredModel.name ?? id),
        });
      }
    }
    return [...modelsById.values()];
  }, [availableModels, configuredModels]);

  const groupedModels = useMemo(
    () => groupBy(selectableModels, (model) => getModelGroup(model.id)),
    [selectableModels],
  );
  const selectedModels = selectableModels.filter((model) => selectedModelIds.has(model.id));
  const allSelected =
    selectableModels.length > 0 && selectedModelIds.size === selectableModels.length;
  const isBaseUrlValid = isValidHttpUrl(baseUrl);

  const toggleModel = (modelId: string) => {
    setSelectedModelIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!isBaseUrlValid || selectedModels.length === 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const succeeded = await onSync({
        baseUrl: baseUrl.trim(),
        models: selectedModels.map((model) => ({ id: model.id, name: model.name })),
        syncAccounts,
      });
      if (succeeded) {
        onOpenChange(false);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!isSubmitting) {
          onOpenChange(open);
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b p-5 pb-4">
          <DialogTitle>
            {t('proxy.open-code.model-dialog-title', 'Choose OpenCode models')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'proxy.open-code.model-dialog-description',
              'Selected models are added or updated. Unselected existing models are not deleted.',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-1">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="open-code-base-url">
                {t('proxy.open-code.custom-base-url', 'Custom Manager BaseURL')}
              </Label>
              {baseUrl !== initialBaseUrl ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setBaseUrl(initialBaseUrl)}
                >
                  <RefreshCw className="mr-1.5 size-3.5" />
                  {t('proxy.open-code.reset-base-url', 'Reset')}
                </Button>
              ) : null}
            </div>
            <Input
              id="open-code-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              aria-invalid={!isBaseUrlValid}
              placeholder="http://127.0.0.1:8045/v1"
            />
            {!isBaseUrlValid ? (
              <p className="text-destructive text-xs">
                {t('proxy.open-code.invalid-base-url', 'Enter a valid HTTP or HTTPS URL.')}
              </p>
            ) : null}
          </div>

          <label
            htmlFor="open-code-sync-accounts"
            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
          >
            <Checkbox
              id="open-code-sync-accounts"
              checked={syncAccounts}
              onCheckedChange={(checked) => onSyncAccountsChange(checked === true)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {t('proxy.open-code.sync-accounts', 'Sync accounts to antigravity-accounts.json')}
              </span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {t(
                  'proxy.open-code.sync-accounts-description',
                  'OpenCode requires refresh tokens in its local plugin file. This option is off by default; tokens never cross the renderer IPC response or logs.',
                )}
              </span>
            </span>
          </label>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {t('proxy.open-code.select-models', 'Models to add or update')}
                </div>
                <div className="text-muted-foreground text-xs">
                  {t('proxy.open-code.selected-count', '{{selected}} of {{total}} selected', {
                    selected: selectedModels.length,
                    total: selectableModels.length,
                  })}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setSelectedModelIds(
                    allSelected ? new Set() : new Set(selectableModels.map((model) => model.id)),
                  )
                }
              >
                {allSelected
                  ? t('proxy.open-code.deselect-all', 'Deselect all')
                  : t('proxy.open-code.select-all', 'Select all')}
              </Button>
            </div>

            <div className="max-h-[38vh] space-y-4 overflow-y-auto rounded-lg border p-3">
              {Object.entries(groupedModels).map(([group, models]) => (
                <fieldset key={group} className="space-y-2">
                  <legend className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                    {group}
                  </legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {models.map((model) => (
                      <label
                        key={model.id}
                        className="hover:bg-muted/60 flex cursor-pointer items-start gap-2 rounded-md border p-2.5 transition-colors"
                      >
                        <Checkbox
                          checked={selectedModelIds.has(model.id)}
                          onCheckedChange={() => toggleModel(model.id)}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{model.name}</span>
                          <span className="text-muted-foreground block truncate font-mono text-[11px]">
                            {model.id}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="border-t p-5 pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || !isBaseUrlValid || selectedModels.length === 0}
          >
            {isSubmitting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {t('proxy.open-code.confirm-sync', 'Confirm sync')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
