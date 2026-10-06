import { useId, type ReactNode } from 'react';
import { CircleAlert, Inbox, LoaderCircle } from 'lucide-react';
import { cn } from '@/shared/ui/utils';

interface FeedbackStateProps {
  kind: 'loading' | 'empty' | 'error';
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}
const ICONS = { loading: LoaderCircle, empty: Inbox, error: CircleAlert };

export function FeedbackState({
  kind,
  title,
  description,
  children,
  className,
}: FeedbackStateProps) {
  const titleId = useId();
  const Icon = ICONS[kind];
  return (
    <section
      role={kind === 'error' ? 'alert' : 'status'}
      aria-labelledby={titleId}
      aria-busy={kind === 'loading' || undefined}
      className={cn(
        'flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center',
        className,
      )}
    >
      <div
        className={cn(
          'mb-4 flex size-12 shrink-0 items-center justify-center rounded-2xl border',
          kind === 'error'
            ? 'border-destructive/25 bg-destructive/10 text-destructive'
            : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon
          className={cn('size-5', kind === 'loading' && 'animate-spin motion-reduce:animate-none')}
          aria-hidden="true"
        />
      </div>
      <h2 id={titleId} className="text-foreground text-sm font-semibold">
        {title}
      </h2>
      {description && (
        <div className="text-muted-foreground mt-2 max-w-md text-sm leading-relaxed">
          {description}
        </div>
      )}
      {children && <div className="mt-5 w-full max-w-xl">{children}</div>}
    </section>
  );
}
