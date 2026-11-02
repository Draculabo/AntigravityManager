import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

afterEach(cleanup);

function options() {
  return (
    <>
      <SelectTrigger aria-label="Account">
        <SelectValue placeholder="Select account" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All accounts</SelectItem>
        <SelectItem value="account-1">developer@example.test</SelectItem>
      </SelectContent>
    </>
  );
}

describe('Select value semantics', () => {
  it.each(['controlled', 'uncontrolled'] as const)(
    'shows the placeholder for an empty %s value',
    (mode) => {
      render(
        mode === 'controlled' ? (
          <Select value="">{options()}</Select>
        ) : (
          <Select defaultValue="">{options()}</Select>
        ),
      );
      const trigger = screen.getByRole('combobox', { name: 'Account' });
      expect(trigger.textContent).toBe('Select account');
      expect(trigger.hasAttribute('data-placeholder')).toBe(true);
    },
  );

  it('restores the placeholder when a controlled selection is cleared', () => {
    const view = render(<Select value="account-1">{options()}</Select>);
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    expect(trigger.textContent).toBe('developer@example.test');
    view.rerender(<Select value="">{options()}</Select>);
    expect(trigger.textContent).toBe('Select account');
    expect(trigger.hasAttribute('data-placeholder')).toBe(true);
  });

  it('preserves nonempty account filter values when choosing an option', () => {
    const onValueChange = vi.fn();
    render(
      <Select defaultValue="all" onValueChange={onValueChange}>
        {options()}
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    expect(trigger.textContent).toBe('All accounts');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(screen.getByRole('option', { name: 'developer@example.test' }));
    expect(onValueChange.mock.calls).toEqual([['account-1']]);
    expect(trigger.textContent).toBe('developer@example.test');
  });
});
