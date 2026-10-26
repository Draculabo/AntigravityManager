import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TrafficTable } from '@/modules/proxy-gateway/traffic-monitor/components/TrafficTable';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(tab: 'model' | 'auxiliary' = 'model') {
  return render(
    createElement(TrafficTable, {
      items: [],
      loading: false,
      tab,
      onOpen: vi.fn(),
      onCopyCurl: vi.fn(),
    }),
  );
}
it('exposes current resize bounds, persists keyboard changes by category and makes reset visible', () => {
  const view = mount();
  const separator = screen.getAllByRole('separator')[0];
  expect(separator.getAttribute('aria-valuenow')).toBe('150');
  expect(separator.getAttribute('aria-valuemin')).toBe('45');
  expect(separator.getAttribute('aria-valuemax')).toBe('640');
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  expect(separator.getAttribute('aria-valuenow')).toBe('166');
  expect(JSON.parse(localStorage.getItem('traffic-table-columns:model') ?? '{}').time).toBe(166);
  view.unmount();
  mount('auxiliary');
  expect(screen.getAllByRole('separator')[0].getAttribute('aria-valuenow')).toBe('150');
  const reset = screen.getByRole('button', { name: 'traffic.reset-columns' });
  expect(reset.classList.contains('sr-only')).toBe(false);
  fireEvent.click(reset);
  expect(localStorage.getItem('traffic-table-columns:model')).not.toBeNull();
});
it.each(['pointercancel', 'blur', 'unmount'] as const)(
  'releases an active drag on %s',
  (ending) => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = mount();
    fireEvent.pointerDown(screen.getAllByRole('separator')[0], {
      clientX: 100,
      button: 0,
      pointerId: 1,
    });
    const move = add.mock.calls.find(([event]) => event === 'pointermove')?.[1];
    expect(move).toBeTypeOf('function');
    if (ending === 'unmount') {
      view.unmount();
    } else if (ending === 'pointercancel') {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    } else {
      fireEvent(window, new Event(ending));
    }
    expect(
      remove.mock.calls.some(([event, listener]) => event === 'pointermove' && listener === move),
    ).toBe(true);
  },
);
it('keeps the current layout and reports unsaved changes when storage is denied', () => {
  const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('denied', 'SecurityError');
  });
  mount();
  fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'ArrowRight' });
  expect(write).toHaveBeenCalled();
  expect(screen.getAllByRole('separator')[0].getAttribute('aria-valuenow')).toBe('166');
  expect(screen.getByText('traffic.columns-unsaved').getAttribute('role')).toBe('status');
  fireEvent.click(screen.getByRole('button', { name: 'traffic.reset-columns' }));
  expect(screen.getAllByRole('separator')[0].getAttribute('aria-valuenow')).toBe('150');
});
it('keeps the header on the body scroll surface and isolates a live drag from other pointers', () => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  const view = mount();
  const separator = screen.getAllByRole('separator')[0];
  fireEvent.pointerDown(separator, { clientX: 100, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 160, pointerId: 2 });
  expect(separator.getAttribute('aria-valuenow')).toBe('150');
  fireEvent.pointerMove(window, { clientX: 160, pointerId: 1 });
  expect(separator.getAttribute('aria-valuenow')).toBe('210');
  fireEvent.pointerUp(window, { pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: 190, pointerId: 1 });
  expect(separator.getAttribute('aria-valuenow')).toBe('210');
  const scroll = view.container.querySelector<HTMLDivElement>('.overflow-auto');
  if (!scroll) {
    throw new Error('Missing table scroll owner');
  }
  fireEvent.scroll(scroll, { target: { scrollLeft: 180 } });
  const header = separator.closest('.overflow-hidden');
  expect(header?.scrollLeft).toBe(180);
});
