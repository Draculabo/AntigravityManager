import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

describe('Select and SelectItem resilience', () => {
  it('does not throw when SelectItem is rendered with an empty string value', () => {
    expect(() => {
      render(
        createElement(
          Select,
          { defaultValue: '' },
          createElement(
            SelectTrigger,
            { 'aria-label': 'test-select' },
            createElement(SelectValue, { placeholder: 'Select option' }),
          ),
          createElement(
            SelectContent,
            null,
            createElement(SelectItem, { value: '' }, 'All items'),
            createElement(SelectItem, { value: 'item-1' }, 'Item 1'),
          ),
        ),
      );
    }).not.toThrow();

    expect(screen.getByRole('combobox', { name: 'test-select' })).toBeTruthy();
  });
});
