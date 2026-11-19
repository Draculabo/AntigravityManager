import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ConnectionProfileSaveInputSchema,
  type ConnectionProfileSaveInput,
} from '../connection-profiles/connection-profiles.schema';

export function ConnectionProfileOptions({
  id,
  draft,
  modelText,
  clientName,
  edit,
  setModelText,
}: {
  id: string;
  draft: ConnectionProfileSaveInput;
  modelText: string;
  clientName: string;
  edit(patch: Partial<ConnectionProfileSaveInput>): void;
  setModelText(value: string): void;
}) {
  const { t } = useTranslation();
  function changeProtocol(protocol: ConnectionProfileSaveInput['protocol']) {
    edit({
      protocol,
      sdk:
        draft.client !== 'opencode'
          ? null
          : protocol === 'anthropic-messages'
            ? '@ai-sdk/anthropic'
            : protocol === 'openai-responses'
              ? '@ai-sdk/openai'
              : '@ai-sdk/openai-compatible',
    });
  }

  return (
    <details>
      <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
        {t('client-config.connection-options')}
      </summary>
      <div className="mt-3 space-y-3">
        <div className="space-y-1">
          <Label htmlFor={id + '-name'}>{t('client-config.profile-name')}</Label>
          <Input
            id={id + '-name'}
            placeholder={clientName}
            value={draft.name}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id + '-url'}>{t('agent-tools.address')}</Label>
          <Input
            id={id + '-url'}
            value={draft.baseUrl}
            onChange={(event) => edit({ baseUrl: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={id + '-credential'}>{t('client-config.profile-credential')}</Label>
          <Select
            value={draft.credentialSource}
            onValueChange={(value) => {
              const source =
                ConnectionProfileSaveInputSchema.shape.credentialSource.safeParse(value);
              if (source.success) {
                edit({ credentialSource: source.data });
              }
            }}
          >
            <SelectTrigger id={id + '-credential'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {draft.id ? (
                <SelectItem value="keep">{t('client-config.profile-key-keep')}</SelectItem>
              ) : null}
              <SelectItem value="manager-default">
                {t('client-config.profile-key-manager')}
              </SelectItem>
              <SelectItem value="opencode-dedicated">
                {t('client-config.profile-key-opencode')}
              </SelectItem>
              <SelectItem value="client-configured">
                {t('client-config.profile-key-client')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {draft.client === 'opencode' || draft.client === 'dsh' ? (
          <div className="space-y-1">
            <Label htmlFor={id + '-protocol'}>{t('client-config.protocol')}</Label>
            <Select
              value={draft.protocol}
              onValueChange={(value) => {
                if (
                  value === 'anthropic-messages' ||
                  value === 'openai-completions' ||
                  value === 'openai-responses'
                ) {
                  changeProtocol(value);
                }
              }}
            >
              <SelectTrigger id={id + '-protocol'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
                <SelectItem value="openai-completions">OpenAI Chat Completions</SelectItem>
                <SelectItem value="openai-responses">OpenAI Responses</SelectItem>
              </SelectContent>
            </Select>
            {draft.sdk ? <p className="text-muted-foreground text-xs">{draft.sdk}</p> : null}
          </div>
        ) : null}
        {draft.client === 'dsh' ? (
          <div className="space-y-1">
            <Label htmlFor={id + '-dsh'}>{t('client-config.profile')}</Label>
            <Input
              id={id + '-dsh'}
              value={draft.dshProfile ?? ''}
              onChange={(event) => edit({ dshProfile: event.target.value })}
            />
          </div>
        ) : null}
        {draft.client === 'openclaw' ? (
          <div className="space-y-1">
            <Label htmlFor={id + '-version'}>{t('client-config.openclaw-version')}</Label>
            <Select
              value={draft.version ?? ''}
              onValueChange={(value) => {
                if (value === 'v1' || value === 'v2') {
                  edit({ version: value });
                }
              }}
            >
              <SelectTrigger id={id + '-version'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="v1">v1</SelectItem>
                <SelectItem value="v2">v2</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{t('client-config.version-help')}</p>
          </div>
        ) : null}
        {draft.client === 'hermes' ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={id + '-discover'}
              checked={draft.discoverModels}
              onCheckedChange={(checked) => edit({ discoverModels: checked === true })}
            />
            <Label htmlFor={id + '-discover'}>{t('client-config.discover-models')}</Label>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={id + '-models'}>{t('client-config.model-ids')}</Label>
          <Textarea
            id={id + '-models'}
            value={modelText}
            onChange={(event) => {
              setModelText(event.target.value);
              edit({});
            }}
          />
        </div>
        <p className="text-muted-foreground text-xs">{t('client-config.backend-key')}</p>
      </div>
    </details>
  );
}
