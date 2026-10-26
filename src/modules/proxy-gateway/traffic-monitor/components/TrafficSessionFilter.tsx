import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function TrafficSessionFilter({
  sessionId,
  onApply,
}: {
  sessionId?: string;
  onApply: (value?: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(sessionId ?? '');
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft.trim() || undefined);
      }}
    >
      <label className="text-muted-foreground flex items-center gap-1.5">
        {t('traffic.exact-session')}
        <Input
          aria-label={t('traffic.exact-session')}
          className="h-8 w-52 text-xs"
          maxLength={512}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <Button size="sm" variant="outline" type="submit">
        {t('traffic.apply-session')}
      </Button>
      {(sessionId || draft) && (
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            setDraft('');
            onApply(undefined);
          }}
        >
          {t('traffic.reset-session')}
        </Button>
      )}
    </form>
  );
}
