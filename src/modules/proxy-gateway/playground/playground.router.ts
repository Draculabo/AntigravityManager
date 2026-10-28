import { os } from '@orpc/server';
import {
  PlaygroundCompareInputSchema,
  PlaygroundCompareResultSchema,
  PlaygroundExecuteInputSchema,
  PlaygroundExecuteResultSchema,
} from './playground.schema';
import { playgroundService, type PlaygroundService } from './playground.service';

export function createPlaygroundRouter(service: PlaygroundService = playgroundService) {
  return os.router({
    execute: os
      .input(PlaygroundExecuteInputSchema)
      .output(PlaygroundExecuteResultSchema)
      .handler(async ({ input, signal }) => {
        return service.execute(input, signal);
      }),

    compare: os
      .input(PlaygroundCompareInputSchema)
      .output(PlaygroundCompareResultSchema)
      .handler(async ({ input, signal }) => {
        return service.compare(input, signal);
      }),
  });
}
