import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { TrafficAuditBodySearchResult } from '../audit/traffic-audit.types';

export function AuditBodySearchResults({
  result,
  onJump,
}: {
  result: TrafficAuditBodySearchResult;
  onJump: (match: TrafficAuditBodySearchResult['matches'][number]) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState({ result, index: -1 });
  const [pending, setPending] = useState(false);
  const jumping = useRef(false);
  if (selection.result !== result) {
    setSelection({ result, index: -1 });
  }
  async function jump(index: number) {
    if (jumping.current || index < 0 || index >= result.matches.length) {
      return;
    }
    jumping.current = true;
    setPending(true);
    try {
      if (await onJump(result.matches[index])) {
        setSelection({ result, index });
      }
    } finally {
      jumping.current = false;
      setPending(false);
    }
  }
  return (
    <div className="bg-muted/20 max-h-36 overflow-auto border-b px-3 py-2 text-xs">
      <div className="text-muted-foreground mb-1 flex flex-wrap items-center gap-2">
        <span role="status">
          {t('traffic.match-position', {
            current: selection.index + 1,
            count: result.matches.length,
          })}
          {result.truncated ? ` (${t('traffic.first-100')})` : ''}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || selection.index <= 0}
          onClick={() => void jump(selection.index - 1)}
        >
          {t('traffic.previous-match')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || selection.index + 1 >= result.matches.length}
          onClick={() => void jump(selection.index + 1)}
        >
          {t('traffic.next-match')}
        </Button>
      </div>
      {result.matches.slice(0, 20).map((match, index) => (
        <button
          key={`${match.offset}-${match.sequence}`}
          type="button"
          disabled={pending}
          aria-pressed={selection.index === index}
          className="hover:bg-muted focus-visible:ring-ring block w-full cursor-default truncate rounded px-1 py-0.5 text-left font-mono focus-visible:ring-2"
          onClick={() => void jump(index)}
        >
          @{match.offset}: {match.snippet}
        </button>
      ))}
    </div>
  );
}
