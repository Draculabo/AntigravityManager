// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommitOnBlurNumberInput } from '@/components/ui/input';

describe('CommitOnBlurNumberInput', () => {
  it('commits only the final edited value when the input loses focus', () => {
    const onCommit = vi.fn();
    render(
      createElement(CommitOnBlurNumberInput, {
        'aria-label': 'Quota alert threshold',
        value: 20,
        onCommit,
      }),
    );

    const input = screen.getByRole('spinbutton', { name: 'Quota alert threshold' });
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.change(input, { target: { value: '25' } });

    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith('25');
  });

  it('resets the draft when the persisted value changes', () => {
    const onCommit = vi.fn();
    const { rerender } = render(
      createElement(CommitOnBlurNumberInput, {
        'aria-label': 'Gateway port',
        value: 8045,
        onCommit,
      }),
    );
    const input = screen.getByRole('spinbutton', { name: 'Gateway port' });
    fireEvent.change(input, { target: { value: '9000' } });

    rerender(
      createElement(CommitOnBlurNumberInput, {
        'aria-label': 'Gateway port',
        value: 8317,
        onCommit,
      }),
    );

    expect(
      (screen.getByRole('spinbutton', { name: 'Gateway port' }) as HTMLInputElement).value,
    ).toBe('8317');
  });
});
