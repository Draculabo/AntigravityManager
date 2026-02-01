import { routeTree } from '@/routeTree.gen';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export const router = createRouter({
  defaultPendingMinMs: 0,
  defaultPreload: 'intent', // Preload on hover/focus
  defaultPreloadStaleTime: 1000 * 60, // Keep preloaded data for 1 minute
  routeTree,
  history: createMemoryHistory({
    initialEntries: ['/'],
  }),
});
