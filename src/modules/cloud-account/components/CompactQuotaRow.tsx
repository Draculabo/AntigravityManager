import type { ReactNode } from 'react';

interface CompactQuotaRowProps {
  label: string;
  children: ReactNode;
}

export function CompactQuotaRow({ label, children }: CompactQuotaRowProps) {
  return (
    <div role="group" aria-label={label} className="mt-1 flex min-w-0 items-start gap-2">
      <span className="text-muted-foreground w-9 shrink-0 pt-0.5 text-[10px] font-semibold">
        {label}
      </span>
      <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(min(100%,10rem),1fr))] gap-x-4 gap-y-2">
        {children}
      </div>
    </div>
  );
}
