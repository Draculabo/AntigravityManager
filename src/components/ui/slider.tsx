/**
 * @created by https://github.com/abdul-zailani
 */
import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider'

import { cn } from '@/lib/utils';

/**
 * Props for the Slider component.
 *
 * @remarks
 * For controlled usage, both `value` and `onValueChange` should be provided.
 * For uncontrolled usage, use `defaultValue` instead.
 *
 * @example
 * ```tsx
 * // Controlled usage
 * <Slider value={[50]} onValueChange={(val) => setValue(val)} min={0} max={100} />
 *
 * // Uncontrolled usage
 * <Slider defaultValue={[50]} min={0} max={100} />
 * ```
 */
export interface SliderProps extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /** Current value(s) of the slider. Required for controlled usage along with onValueChange. */
  value?: number[];
  /** Default value(s) for uncontrolled usage. */
  defaultValue?: number[];
  /** Callback fired when the slider value changes. Required for controlled usage. */
  onValueChange?: (value: number[]) => void;
  /** Callback fired when the user finishes dragging. */
  onValueCommit?: (value: number[]) => void;
  /** Minimum value of the slider. @default 0 */
  min?: number;
  /** Maximum value of the slider. @default 100 */
  max?: number;
  /** Step increment between values. @default 1 */
  step?: number;
}

const Slider = React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
  (
    {
      className,
      value,
      defaultValue,
      onValueChange,
      onValueCommit,
      min = 0,
      max = 100,
      step = 1,
      minStepsBetweenThumbs,
      orientation,
      disabled,
      inverted,
      dir,
      name,
      ...rest
    },
    ref,
  ) => {
    // Runtime validation for controlled component pattern
    if (process.env.NODE_ENV !== 'production') {
      if (value !== undefined && onValueChange === undefined) {
        console.warn(
          'Slider: `value` prop is provided without `onValueChange`. ' +
            'This will result in a read-only slider. ' +
            'Either provide `onValueChange` for controlled usage or use `defaultValue` for uncontrolled usage.',
        );
      }
    }

    return (
      <SliderPrimitive.Root
        ref={ref}
        className={cn('relative flex w-full touch-none items-center select-none', className)}
        value={value}
        defaultValue={defaultValue ?? [min]}
        onValueChange={onValueChange}
        onValueCommit={onValueCommit}
        min={min}
        max={max}
        step={step}
        minStepsBetweenThumbs={minStepsBetweenThumbs}
        orientation={orientation}
        disabled={disabled}
        inverted={inverted}
        dir={dir}
        name={name}
        {...rest}
      >
        <SliderPrimitive.Track className="bg-secondary relative h-2 w-full grow overflow-hidden rounded-full">
          <SliderPrimitive.Range className="bg-primary absolute h-full" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="border-primary bg-background ring-offset-background focus-visible:ring-ring block h-5 w-5 rounded-full border-2 transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" />
      </SliderPrimitive.Root>
    );
  },
);
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };

