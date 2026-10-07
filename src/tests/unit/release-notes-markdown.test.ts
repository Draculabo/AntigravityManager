// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReleaseNotesMarkdown } from '@/modules/app-shell/components/ReleaseNotesMarkdown';

afterEach(cleanup);

describe('release notes Markdown', () => {
  it('renders headings, tables and code while keeping the complete description', () => {
    const { container } = render(
      createElement(ReleaseNotesMarkdown, {
        notes:
          '# Features\n\n- A change\n\n| Type | Result |\n| --- | --- |\n| Fix | Works |\n\n```ts\nconst ready = true;\n```\n\n## Contributors\n\nThanks to everyone.',
        onOpenLink: vi.fn(),
      }),
    );
    expect(screen.getByRole('heading', { name: 'Features' })).toBeTruthy();
    expect(screen.getByRole('table').textContent).toBe('TypeResultFixWorks');
    expect(container.querySelector('pre')?.textContent).toBe('const ready = true;\n');
    expect(screen.getByText('Thanks to everyone.')).toBeTruthy();
  });

  it('routes approved links through the explicit opening action', () => {
    const onOpenLink = vi.fn();
    const url = 'https://github.com/Draculabo/AntigravityManager/pull/123';
    render(createElement(ReleaseNotesMarkdown, { notes: `[PR #123](${url})`, onOpenLink }));
    fireEvent.click(screen.getByRole('link', { name: 'PR #123' }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('does not load images, execute HTML or create unsafe navigation', () => {
    const onOpenLink = vi.fn();
    const { container } = render(
      createElement(ReleaseNotesMarkdown, {
        notes:
          '![Preview](https://images.example/preview.png)\n\n[Other site](https://other.example)\n\n[Unsafe](javascript:alert%281%29)\n\n<img src="https://images.example/tracker.png" onerror="alert(1)">\n\n<iframe src="https://other.example"></iframe>',
        onOpenLink,
      }),
    );
    expect(container.querySelectorAll('img, iframe, script, a')).toHaveLength(0);
    expect(container.textContent).toContain('Preview (https://images.example/preview.png)');
    expect(container.textContent).toContain('Other site (https://other.example)');
    expect(onOpenLink).not.toHaveBeenCalled();
  });
});
