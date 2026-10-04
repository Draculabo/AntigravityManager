import { os } from '@orpc/server';
import { z } from 'zod';
import type { cloudAccountMonitorControl } from '../services/cloud-account-monitor-control.service';
import { toCloudMonitorORPCError } from '../services/cloud-account-monitor.error';
import {
  CloudMonitorEnabledInputSchema,
  CloudMonitorModelsSchema,
  CloudMonitorModelsInputSchema,
  CloudMonitorWarmupSchema,
  CloudMonitorMutationResultSchema,
} from '../services/cloud-account-monitor.schema';

export function createCloudMonitorCoreRouter(monitor: typeof cloudAccountMonitorControl) {
  return {
    monitorGetAutoSwitchEnabled: os.output(z.boolean()).handler(async () => {
      try {
        return await monitor.getAutoSwitchEnabled();
      } catch {
        throw toCloudMonitorORPCError();
      }
    }),

    monitorSetAutoSwitchEnabled: os
      .input(CloudMonitorEnabledInputSchema)
      .output(CloudMonitorMutationResultSchema)
      .handler(async ({ input }) => {
        try {
          await monitor.setAutoSwitchEnabled(input.enabled);
          return { success: true as const };
        } catch {
          throw toCloudMonitorORPCError();
        }
      }),

    monitorGetAutoSwitchModelsConfig: os.output(CloudMonitorModelsSchema).handler(async () => {
      try {
        return await monitor.getAutoSwitchModelsConfig();
      } catch {
        throw toCloudMonitorORPCError();
      }
    }),

    monitorSetAutoSwitchModelsConfig: os
      .input(CloudMonitorModelsInputSchema)
      .output(CloudMonitorMutationResultSchema)
      .handler(async ({ input }) => {
        try {
          await monitor.setAutoSwitchModelsConfig(input);
          return { success: true as const };
        } catch {
          throw toCloudMonitorORPCError();
        }
      }),

    monitorGetWeeklyWarmupConfig: os.output(CloudMonitorWarmupSchema).handler(async () => {
      try {
        return await monitor.getWeeklyWarmupConfig();
      } catch {
        throw toCloudMonitorORPCError();
      }
    }),

    monitorSetWeeklyWarmupConfig: os
      .input(CloudMonitorWarmupSchema)
      .output(CloudMonitorMutationResultSchema)
      .handler(async ({ input }) => {
        try {
          await monitor.setWeeklyWarmupConfig(input);
          return { success: true as const };
        } catch {
          throw toCloudMonitorORPCError();
        }
      }),

    monitorForcePoll: os.output(CloudMonitorMutationResultSchema).handler(async () => {
      try {
        await monitor.forcePoll();
        return { success: true as const };
      } catch {
        throw toCloudMonitorORPCError();
      }
    }),
  };
}
