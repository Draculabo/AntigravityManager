import { useId, useState, type ReactNode } from 'react';
import { Loader2, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export interface ToolManagement {
  profiles?(nativeConfigured: boolean, onBusyChange: (busy: boolean) => void): ReactNode;
  nativeSetupBlocked?: boolean;
  nativeRestoreBlocked?: boolean;
  profileApplied?: boolean;
  blocksNativeActivation?(profile?: string): boolean;
}

export function NativeClientSetupCard({
  name,
  defaultModel,
  busy,
  ready,
  onConfigure,
  feedback,
  children,
  configured,
  status,
  management,
  configureLabel,
}: {
  name: string;
  defaultModel?: string;
  busy: boolean;
  ready: boolean;
  onConfigure(): void;
  feedback?: ReactNode;
  children?: ReactNode;
  configured?: boolean;
  status?: ReactNode;
  management?: ToolManagement;
  configureLabel?: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [profilesBusy, setProfilesBusy] = useState(false);
  const isConfigured = configured || management?.profileApplied;

  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
            <Terminal className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 id={id} className="text-sm font-semibold">
              {name}
            </h3>
            <p className="text-muted-foreground text-xs break-words">
              {management?.profileApplied
                ? t('client-config.connection-unverified')
                : (status ??
                  t(isConfigured ? 'agent-tools.configured' : 'agent-tools.not-configured'))}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!isConfigured && !open && (
            <Button
              type="button"
              size="sm"
              onClick={onConfigure}
              disabled={busy || management?.nativeSetupBlocked || !ready || !defaultModel}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {configureLabel ?? t('client-config.quick-configure')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || profilesBusy}
            aria-expanded={open}
            aria-controls={`${id}-manage`}
            onClick={() => setOpen(!open)}
          >
            {t('client-config.manage-tool')}
          </Button>
        </div>
      </div>
      {feedback}
      <div
        id={`${id}-manage`}
        hidden={!open}
        className="bg-muted/30 space-y-4 rounded-md border p-3"
      >
        {open && (
          <>
            {management?.profileApplied && (
              <p className="text-muted-foreground text-sm">
                {t('client-config.managed-by-profile')}
              </p>
            )}
            {children ? (
              <fieldset disabled={profilesBusy} className="min-w-0 space-y-3">
                {children}
              </fieldset>
            ) : null}
            {management?.profiles && (
              <fieldset disabled={busy} className="min-w-0">
                {management.profiles(configured === true, setProfilesBusy)}
              </fieldset>
            )}
          </>
        )}
      </div>
    </section>
  );
}
