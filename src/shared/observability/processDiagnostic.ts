import { z } from 'zod';

/** Closed process observations exclude executable paths, command lines and native error prose. */
export const ProcessDiagnosticSchema = z.strictObject({
  reason: z.enum([
    'busy',
    'missing-executable',
    'target-conflict',
    'directory-conflict',
    'probe-failed',
    'launch-failed',
    'close-failed',
    'exit-unconfirmed',
    'startup-unconfirmed',
    'update-in-progress',
    'switched-hot-unconfirmed',
    'switched-startup-unconfirmed',
    'system-directory-unavailable',
    'window-enumeration-failed',
    'window-close-failed',
    'no-closable-window',
    'native-call-failed',
  ]),
  windowsErrorCode: z.number().int().min(0).max(0xffffffff).optional(),
});
export type ProcessDiagnostic = z.infer<typeof ProcessDiagnosticSchema>;
