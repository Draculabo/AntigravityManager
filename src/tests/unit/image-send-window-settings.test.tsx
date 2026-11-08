import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImageSendWindowSettings } from '@/modules/proxy-gateway/settings/ImageSendWindowSettings';
import { DEFAULT_APP_CONFIG, ImageSchedulerConfigSchema } from '@/modules/config/types';
import { serviceConfigPlaceholder } from '@/modules/config/settings-change';

const update = vi.hoisted(() => vi.fn());
vi.mock('@/ipc/manager', () => ({ ipc: { client: { config: { service: { update } } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
let cache: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  cache = new QueryClient();
});
afterEach(() => {
  cleanup();
  cache.clear();
});
const config = DEFAULT_APP_CONFIG.proxy.image_scheduler;
function mount(available = true, strategy: 'count' | 'memory' = 'count') {
  return render(
    <QueryClientProvider client={cache}>
      <ImageSendWindowSettings
        config={{ ...config, send_window_enabled: true, send_window_strategy: strategy }}
        available={available}
      />
    </QueryClientProvider>,
  );
}

it('defaults legacy configuration to count without enabling the window', () => {
  expect(ImageSchedulerConfigSchema.parse({})).toEqual(config);
  expect(ImageSchedulerConfigSchema.safeParse({ send_window_strategy: 'combined' }).success).toBe(
    false,
  );
});

it('saves only window fields and reports a pending core application', async () => {
  update.mockResolvedValue({ state: 'restart-required', snapshot: serviceConfigPlaceholder() });
  mount();
  fireEvent.change(screen.getByLabelText('image-send-window.count'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'image-send-window.save' }));
  await screen.findByText('image-send-window.pending');
  expect(update).toHaveBeenCalledExactlyOnceWith({
    proxy: {
      image_scheduler: {
        send_window_enabled: true,
        send_window_strategy: 'count',
        send_window_count: 0,
        send_window_strip_remote_urls: false,
      },
    },
  });
  expect(cache.getQueryData(['serviceConfig'])).toEqual(serviceConfigPlaceholder());
});

it('keeps failed edits for an explicit retry and validates the active budget', async () => {
  update
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ state: 'applied', snapshot: serviceConfigPlaceholder() });
  mount(true, 'memory');
  const input = screen.getByLabelText('image-send-window.memory');
  fireEvent.change(input, { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'image-send-window.save' }));
  await screen.findByText('image-send-window.invalid-memory');
  expect(update).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '16' } });
  fireEvent.click(screen.getByRole('button', { name: 'image-send-window.save' }));
  await screen.findByText('image-send-window.failed');
  expect((input as HTMLInputElement).value).toBe('16');
  fireEvent.click(screen.getByRole('button', { name: 'image-send-window.save' }));
  await screen.findByText('image-send-window.saved');
  expect(update).toHaveBeenLastCalledWith({
    proxy: {
      image_scheduler: {
        send_window_enabled: true,
        send_window_strategy: 'memory',
        send_window_memory_mib: 16,
      },
    },
  });
});

it('disables unavailable settings and does not issue a configuration update', () => {
  mount(false);
  const button = screen.getByRole('button', { name: 'image-send-window.save' });
  expect(button.closest('fieldset')?.disabled).toBe(true);
  fireEvent.click(button);
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe('image-send-window.unavailable');
});

it('admits only one save while the owner reply is pending', async () => {
  let finish!: (value: object) => void;
  update.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mount();
  fireEvent.change(screen.getByLabelText('image-send-window.count'), { target: { value: '4' } });
  const button = screen.getByRole('button', { name: 'image-send-window.save' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(update).toHaveBeenCalledTimes(1);
  finish({ state: 'applied', snapshot: serviceConfigPlaceholder() });
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('image-send-window.saved'),
  );
});
