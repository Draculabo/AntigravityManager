import * as React from 'react';
import { cn } from '@/shared/ui/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export interface CommitOnBlurNumberInputProps extends Omit<
  InputProps,
  'defaultValue' | 'onBlur' | 'onChange' | 'type' | 'value'
> {
  value: number;
  onCommit: (value: string) => void | Promise<void>;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'border-input placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

const CommitOnBlurNumberInput = React.forwardRef<HTMLInputElement, CommitOnBlurNumberInputProps>(
  ({ value, onCommit, ...props }, ref) => (
    <Input
      {...props}
      key={value}
      ref={ref}
      type="number"
      defaultValue={value}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  ),
);

export { CommitOnBlurNumberInput, Input };
