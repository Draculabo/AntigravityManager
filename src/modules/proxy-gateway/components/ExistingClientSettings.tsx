import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AgentToolSyncCard } from './AgentToolSyncCard';
import { ClientConfigSyncCard } from './ClientConfigSyncCard';
import { DshSyncCard } from './DshSyncCard';
import { OpenCodeSyncCard } from './OpenCodeSyncCard';
import type { ProxyExampleModel } from './proxy-example-models';

const existingClients = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'hermes', name: 'Hermes' },
  { id: 'openclaw', name: 'OpenClaw' },
  { id: 'dsh', name: 'DSH' },
] as const;

export function ExistingClientSettings({
  baseUrl,
  models,
}: {
  baseUrl: string;
  models: readonly ProxyExampleModel[];
}) {
  const { t } = useTranslation();
  const [client, setClient] = useState<(typeof existingClients)[number]['id']>();

  return (
    <details className="bg-card rounded-lg border p-4">
      <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none">
        {t('client-config.existing-settings')}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground text-sm">{t('client-config.existing-settings-help')}</p>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={t('client-config.profile-client')}
        >
          {existingClients.map(({ id, name }) => (
            <Button
              key={id}
              type="button"
              variant="outline"
              aria-pressed={id === client}
              onClick={() => setClient(id)}
            >
              {name}
            </Button>
          ))}
        </div>
        {(client === 'claude' || client === 'codex') && (
          <AgentToolSyncCard key={client} tool={client} baseUrl={baseUrl} models={models} />
        )}
        {client === 'opencode' && <OpenCodeSyncCard baseUrl={baseUrl} models={models} />}
        {(client === 'hermes' || client === 'openclaw') && (
          <ClientConfigSyncCard key={client} client={client} baseUrl={baseUrl} />
        )}
        {client === 'dsh' && <DshSyncCard baseUrl={baseUrl} />}
      </div>
    </details>
  );
}
