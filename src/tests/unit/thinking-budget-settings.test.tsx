import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThinkingBudgetSettings } from '@/modules/config/components/ThinkingBudgetSettings';
import { DEFAULT_APP_CONFIG, type ThinkingBudgetConfig } from '@/modules/config/types';
import { serviceConfigPlaceholder } from '@/modules/config/settings-change';

const { update, toast } = vi.hoisted(() => ({ update: vi.fn(), toast: vi.fn() }));
vi.mock('@/ipc/manager', () => ({ ipc: { client: { config: { service: { update } } } } }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    disabled,
    onValueChange,
    children,
  }: {
    value: string;
    disabled?: boolean;
    onValueChange(value: string): void;
    children: React.ReactNode;
  }) => (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

beforeEach(() => {
  vi.resetAllMocks();
  update.mockResolvedValue({ state: 'applied', snapshot: serviceConfigPlaceholder() });
});
afterEach(cleanup);

function mount(change: Partial<ThinkingBudgetConfig> = {}, available = true) {
  const onSaved = vi.fn(async () => {});
  render(
    <ThinkingBudgetSettings
      config={{ ...DEFAULT_APP_CONFIG.proxy.thinking_budget, ...change }}
      available={available}
      onSaved={onSaved}
    />,
  );
  return {
    onSaved,
    save: () => fireEvent.click(screen.getByRole('button', { name: 'settings.service-save' })),
  };
}

it('renders field-specific defaults and marks legacy zero values for correction without writing', () => {
  mount({ claude_budget: 0 });
  expect(screen.getByText('settings.thinkingBudget.flash-low-default-hint')).toBeTruthy();
  expect(screen.getByText('settings.thinkingBudget.flash-medium-default-hint')).toBeTruthy();
  expect(
    screen.getByLabelText('settings.thinkingBudget.level.default').getAttribute('aria-invalid'),
  ).toBe('true');
  const button = screen.getByRole('button', { name: 'settings.service-save' });
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(button);
  expect(update).not.toHaveBeenCalled();
});

it('normalizes the current draft at Save and rejects a new zero before IPC', async () => {
  const { save } = mount({ claude_budget: 16384 });
  const input = screen.getByLabelText('settings.thinkingBudget.level.default');
  fireEvent.change(input, { target: { value: '0' } });
  save();
  expect(update).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '' } });
  expect(input.getAttribute('value')).toBe('');
  save();
  await waitFor(() =>
    expect(update).toHaveBeenCalledExactlyOnceWith({
      proxy: { thinking_budget: { claude_budget: -1 } },
    }),
  );
});

it('saves the selected source and budget together after explicit Save', async () => {
  const { save } = mount({ control_source: 'client' });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gateway' } });
  fireEvent.change(screen.getByLabelText('settings.thinkingBudget.level.default'), {
    target: { value: '8192' },
  });
  expect(update).not.toHaveBeenCalled();
  save();
  await waitFor(() =>
    expect(update).toHaveBeenCalledExactlyOnceWith({
      proxy: { thinking_budget: { claude_budget: 8192, control_source: 'gateway' } },
    }),
  );
});

it('allows switching to Client while retaining hidden legacy budget values', async () => {
  const { save } = mount({ claude_budget: 0 });
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'client' } });
  expect(screen.queryByLabelText('settings.thinkingBudget.level.default')).toBeNull();
  save();
  await waitFor(() =>
    expect(update).toHaveBeenCalledExactlyOnceWith({
      proxy: { thinking_budget: { control_source: 'client' } },
    }),
  );
});

it.each(['rejected', 'partial-failure'] as const)(
  'retains an editable retry after %s',
  async (failure) => {
    if (failure === 'rejected') {
      update.mockRejectedValueOnce(new Error('Owner unavailable'));
    } else {
      update.mockResolvedValueOnce({
        state: 'partial-failure',
        snapshot: serviceConfigPlaceholder(),
      });
    }
    const { save } = mount();
    const input = screen.getByLabelText('settings.thinkingBudget.level.default');
    fireEvent.change(input, { target: { value: '8192' } });
    save();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    );
    expect(input.getAttribute('value')).toBe('8192');
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls).toEqual([
      [{ proxy: { thinking_budget: { claude_budget: 8192 } } }],
      [{ proxy: { thinking_budget: { claude_budget: 8192 } } }],
    ]);
  },
);

it('keeps unavailable settings read-only', () => {
  const { save } = mount({}, false);
  expect(
    screen.getByLabelText('settings.thinkingBudget.level.default').closest('fieldset')?.disabled,
  ).toBe(true);
  save();
  expect(update).not.toHaveBeenCalled();
});
