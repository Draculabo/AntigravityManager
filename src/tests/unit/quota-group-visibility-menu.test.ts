import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QuotaGroupVisibilityMenu } from '@/modules/cloud-account/components/QuotaGroupVisibilityMenu';
import { DEFAULT_QUOTA_GROUP_VISIBILITY } from '@/modules/cloud-account/utils/quota-group-visibility';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

it('lets users independently toggle all four quota groups while keeping the menu open', async () => {
  const onChange = vi.fn();
  function Menu() {
    const [value, setValue] = useState(DEFAULT_QUOTA_GROUP_VISIBILITY);
    return createElement(QuotaGroupVisibilityMenu, {
      value,
      onChange: (next) => {
        onChange(next);
        setValue(next);
      },
    });
  }
  render(createElement(Menu));
  fireEvent.keyDown(screen.getByRole('button', { name: 'cloud.quota-display.title' }), {
    key: 'ArrowDown',
  });
  for (const label of [
    'five-hours-gemini',
    'weekly-claude',
    'weekly-gemini',
    'five-hours-claude',
  ]) {
    const item = await screen.findByRole('menuitemcheckbox', {
      name: `cloud.quota-display.${label}`,
    });
    expect(item.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(item);
    expect(item.getAttribute('aria-checked')).toBe('false');
  }
  expect(onChange.mock.calls.map(([value]) => value)).toEqual([
    { fiveHour: { gemini: false, claude: true }, weekly: { gemini: true, claude: true } },
    { fiveHour: { gemini: false, claude: true }, weekly: { gemini: true, claude: false } },
    { fiveHour: { gemini: false, claude: true }, weekly: { gemini: false, claude: false } },
    { fiveHour: { gemini: false, claude: false }, weekly: { gemini: false, claude: false } },
  ]);
});
