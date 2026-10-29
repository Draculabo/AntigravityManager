import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/shared/ui/utils';

const buttonVariants = cva(
  "inline-flex cursor-default select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm leading-[22px] font-medium shadow-none transition-[background-color,border-color,color] duration-150 ease-out active:brightness-95 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-invalid:border-destructive [@media(pointer:coarse)]:min-h-10",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-border bg-card hover:border-input hover:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 min-h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-9 min-h-9 gap-1.5 px-3 has-[>svg]:px-2.5',
        xs: 'h-7 min-h-7 gap-1.5 rounded-md px-3 text-xs leading-5 has-[>svg]:px-2.5',
        lg: 'h-10 min-h-10 px-6 has-[>svg]:px-4',
        icon: 'size-9 min-h-9',
        'icon-xs': 'size-7 min-h-7 rounded-md [@media(pointer:coarse)]:w-10',
        'icon-lg': 'size-10 min-h-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="button"
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
