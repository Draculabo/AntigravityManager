import type { ReactNode } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  title: string;
  installed?: boolean;
  version?: string | null;
  loading: boolean;
  failed: boolean;
  configured: boolean;
  synced: boolean;
  address?: string | null;
  model?: string | null;
  retry(): void;
  children: ReactNode;
}
export function AgentToolCardFrame(props: Props) {
  const { t } = useTranslation();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="size-5" />
          {props.title}
        </CardTitle>
        <p className="text-muted-foreground text-xs">
          {props.loading
            ? t('agent-tools.loading')
            : props.installed
              ? `${t('agent-tools.installed')}${props.version ? ` · ${props.version}` : ''}`
              : t('agent-tools.not-installed')}
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {props.failed ? (
          <div className="border-destructive/40 rounded-lg border p-3 text-sm" role="alert">
            <p>{t('agent-tools.read-error')}</p>
            <Button variant="outline" size="sm" onClick={props.retry} className="mt-2">
              <RefreshCw className="mr-2 size-4" />
              {t('agent-tools.retry')}
            </Button>
          </div>
        ) : props.loading ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t('agent-tools.loading')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2 text-xs">
            <span
              className={`rounded-md px-2 py-1 ${props.configured ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}
            >
              {props.configured
                ? props.synced
                  ? t('agent-tools.configured')
                  : t('agent-tools.custom-address')
                : t('agent-tools.not-configured')}
            </span>
            {props.configured ? (
              <span className="bg-muted text-muted-foreground rounded-md px-2 py-1">
                {t('agent-tools.not-verified')}
              </span>
            ) : null}
          </div>
        )}
        <div className="space-y-2 rounded-lg border p-3 text-xs">
          <p className="text-muted-foreground">{t('agent-tools.address')}</p>
          <p className="font-mono break-all">
            {props.loading || props.failed ? '—' : (props.address ?? t('agent-tools.not-set'))}
          </p>
          <p className="text-muted-foreground">{t('agent-tools.model')}</p>
          <p className="break-all">
            {props.loading || props.failed ? '—' : (props.model ?? t('agent-tools.choose-model'))}
          </p>
        </div>
        <div className="mt-auto space-y-3">{props.children}</div>
      </CardContent>
    </Card>
  );
}
