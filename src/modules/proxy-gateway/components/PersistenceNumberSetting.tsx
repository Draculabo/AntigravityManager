import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommitOnBlurNumberInput } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Keep numeric drafts local; commit one valid persistence patch on blur or Enter. */
export function PersistenceNumberSetting({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  onCommit: (value: number) => void | Promise<void>;
}) {
  const inputId = useId();
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);
  return (
    <div className="space-y-1">
      <Label htmlFor={inputId} className="text-xs">
        {label}
      </Label>
      <CommitOnBlurNumberInput
        id={inputId}
        value={value}
        min={min}
        step="any"
        aria-invalid={invalid}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onCommit={async (draft) => {
          const next = Number(draft);
          if (!draft.trim() || !Number.isFinite(next) || next < min) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          if (next !== value) {
            await onCommit(next);
          }
        }}
      />
      {invalid && (
        <p role="alert" className="text-destructive text-xs">
          {t('proxy.persistence.invalid-number', { min })}
        </p>
      )}
    </div>
  );
}
