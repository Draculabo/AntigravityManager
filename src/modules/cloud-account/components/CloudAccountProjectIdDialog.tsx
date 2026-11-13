import { ORPCError } from '@orpc/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { fetchAccountProjectId, getAccountProjectId, setAccountProjectId } from '../actions/cloud';

export function CloudAccountProjectIdDialog({
  accountId,
  email,
}: {
  accountId: string;
  email: string;
}) {
  const { t } = useTranslation();

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t('cloud.project-id.title')}
          aria-label={t('cloud.project-id.title')}
        >
          <Braces aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('cloud.project-id.title')}</DialogTitle>
          <DialogDescription className="break-all">{email}</DialogDescription>
        </DialogHeader>
        <ProjectIdEditor key={accountId} accountId={accountId} />
      </DialogContent>
    </Dialog>
  );
}

type ProjectIdChange = { kind: 'save'; projectId: string } | { kind: 'clear' } | { kind: 'fetch' };

function ProjectIdEditor({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const inputId = useId();
  const queryClient = useQueryClient();
  const queryKey = ['cloud-account', 'project-id', accountId];
  const [draft, setDraft] = useState<{ text: string; expectedProjectId: string | null } | null>(
    null,
  );
  const current = useQuery({
    queryKey,
    queryFn: () => getAccountProjectId({ accountId }),
    retry: false,
  });
  const change = useMutation({
    mutationFn: ({
      operation,
      expectedProjectId,
    }: {
      operation: ProjectIdChange;
      expectedProjectId: string | null;
    }) => {
      if (operation.kind === 'fetch') {
        return fetchAccountProjectId({ accountId, expectedProjectId });
      }
      return setAccountProjectId({
        accountId,
        expectedProjectId,
        projectId: operation.kind === 'save' ? operation.projectId : null,
      });
    },
    onSuccess: () => {
      setDraft(null);
      return queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      if (error instanceof ORPCError && error.code === 'CONFLICT') {
        setDraft(null);
      }
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  if (current.isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t('cloud.project-id.loading')}
      </p>
    );
  }
  if (current.isError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-destructive text-sm">
          {t('cloud.project-id.load-failed')}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void current.refetch()}
          disabled={current.isFetching}
        >
          {t('cloud.project-id.retry')}
        </Button>
      </div>
    );
  }

  const saved = current.data.projectId;
  const value = draft?.text ?? saved ?? '';
  const disabled = current.isFetching || change.isPending;
  const apply = (operation: ProjectIdChange) => {
    change.mutate({ operation, expectedProjectId: draft ? draft.expectedProjectId : saved });
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const projectId = value.trim();
        if (!disabled && projectId && projectId !== saved) {
          apply({ kind: 'save', projectId });
        }
      }}
    >
      <label htmlFor={inputId} className="text-sm font-medium">
        {t('cloud.project-id.title')}
      </label>
      <Input
        id={inputId}
        aria-describedby={`${inputId}-help`}
        placeholder={t('cloud.project-id.empty')}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => {
          change.reset();
          setDraft({
            text: event.target.value,
            expectedProjectId: draft ? draft.expectedProjectId : saved,
          });
        }}
      />
      <p id={`${inputId}-help`} className="text-muted-foreground text-sm">
        {t('cloud.project-id.help')}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || saved === null}
          onClick={() => apply({ kind: 'clear' })}
        >
          {t('cloud.project-id.clear')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => apply({ kind: 'fetch' })}
        >
          {t('cloud.project-id.fetch')}
        </Button>
        <Button type="submit" disabled={disabled || !value.trim() || value.trim() === saved}>
          {t('cloud.project-id.save')}
        </Button>
      </div>
      {change.isPending && (
        <p role="status" className="text-muted-foreground text-sm">
          {t('cloud.project-id.updating')}
        </p>
      )}
      {change.isSuccess && (
        <p role="status" className="text-muted-foreground text-sm">
          {t('cloud.project-id.updated')}
        </p>
      )}
      {change.isError && (
        <p role="alert" className="text-destructive text-sm">
          {t(
            change.error instanceof ORPCError && change.error.code === 'CONFLICT'
              ? 'cloud.project-id.conflict'
              : change.variables.operation.kind === 'fetch'
                ? 'cloud.project-id.fetch-failed'
                : 'cloud.project-id.update-failed',
          )}
        </p>
      )}
    </form>
  );
}
