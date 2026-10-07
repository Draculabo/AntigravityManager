import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/message-port';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '@/localization/en';
import zhCN from '@/localization/zh-CN';
import { IPC_CHANNELS } from '@/shared/constants';
import { ManualUpdateNotification } from '@/modules/app-shell/components/ManualUpdateNotification';
import { Button } from '@/components/ui/button';
import type { PreviewClient } from './release-notes-fixture';
import './renderer-updates.css';

const { port1, port2 } = new MessageChannel();
const controls = createORPCClient<PreviewClient>(new RPCLink({ port: port1 }));
declare global {
  interface Window {
    __releaseNotesPreview: { status: PreviewClient['preview']['status'] };
  }
}
window.__releaseNotesPreview = { status: controls.preview.status };
port1.start();
window.postMessage(IPC_CHANNELS.START_ORPC_SERVER, '*', [port2]);
const initial = await controls.preview.status();
const modes = ['ready', 'empty', 'retry', 'slow', 'live'] as const;
const states = ['available', 'downloading', 'downloaded'] as const;
await i18next.use(initReactI18next).init({
  lng: new URLSearchParams(location.search).get('language') ?? 'zh-CN',
  fallbackLng: 'en',
  resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } },
  interpolation: { escapeValue: false },
});

function Preview() {
  const [configuration, setConfiguration] = useState(initial.configuration);
  const [error, setError] = useState('');
  const apply = async () => {
    try {
      setError('');
      await controls.preview.configure(configuration);
    } catch {
      setError('Use a valid release tag, such as v0.23.0.');
    }
  };
  return (
    <main className="bg-background text-foreground min-h-screen space-y-5 p-8">
      <h1 className="text-xl font-semibold">Release notes — local validation</h1>
      <p>This isolated window uses production UI and preload. Update actions are simulated.</p>
      <p>Live GitHub mode runs the production resolver for the specified published tag.</p>
      <div className="flex flex-wrap items-center gap-4">
        <label>
          Scenario{' '}
          <select
            className="bg-background rounded border p-2"
            value={configuration.mode}
            onChange={(event) =>
              setConfiguration({
                ...configuration,
                mode: modes.find((mode) => mode === event.target.value) ?? configuration.mode,
              })
            }
          >
            <option value="ready">Complete Markdown</option>
            <option value="empty">Empty description</option>
            <option value="retry">Fail once, then retry</option>
            <option value="slow">Slow request (30 seconds)</option>
            <option value="live">Live GitHub</option>
          </select>
        </label>
        <label>
          Update state{' '}
          <select
            className="bg-background rounded border p-2"
            value={configuration.state}
            onChange={(event) =>
              setConfiguration({
                ...configuration,
                state: states.find((state) => state === event.target.value) ?? configuration.state,
              })
            }
          >
            <option value="available">Available</option>
            <option value="downloading">Downloading</option>
            <option value="downloaded">Ready to install</option>
          </select>
        </label>
        <label>
          Release tag{' '}
          <input
            className="rounded border p-2"
            value={configuration.tagName}
            onChange={(event) =>
              setConfiguration({ ...configuration, tagName: event.target.value })
            }
          />
        </label>
        <Button onClick={() => void apply()}>Show update notice</Button>
        <Button variant="outline" onClick={() => document.documentElement.classList.toggle('dark')}>
          Toggle theme
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <ManualUpdateNotification />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Preview />
  </QueryClientProvider>,
);
