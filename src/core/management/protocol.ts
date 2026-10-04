import { z } from 'zod';
import { OAuthClientKeySchema } from '@/modules/cloud-account/services/oauth-client-preference.schema';
import { DesktopOAuthCodeSchema } from '@/modules/cloud-account/services/desktop-oauth-login.schema';

export const MANAGEMENT_PROTOCOL_VERSION = 1;
export const OAuthSessionIdSchema = z.uuid();

export const ManagementStatusResponseSchema = z.object({
  version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
  ok: z.literal(true),
  status: z.object({
    state: z.enum(['stopped', 'starting', 'running', 'stopping']),
    pid: z.number().int().positive(),
    gateway: z.object({
      running: z.boolean(),
      port: z.number().int().positive().nullable(),
    }),
  }),
});

export const ManagementShutdownResponseSchema = z.object({
  version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
  ok: z.literal(true),
  shuttingDown: z.literal(true),
});

export const OAuthStartRequestSchema = z.strictObject({
  oauthClientKey: OAuthClientKeySchema.optional(),
});

export const OAuthCompleteRequestSchema = z.strictObject({
  code: DesktopOAuthCodeSchema,
});

export const OAuthCompleteResponseSchema = z.strictObject({
  version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
  ok: z.literal(true),
  accepted: z.literal(true),
});

export const OAuthCancelResponseSchema = z.strictObject({
  version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
  ok: z.literal(true),
  cancelled: z.literal(true),
});

export const OAuthStartResponseSchema = z.strictObject({
  version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
  ok: z.literal(true),
  sessionId: OAuthSessionIdSchema,
  authorizationUrl: z.url(),
});

export const OAuthStatusResponseSchema = z.strictObject({
  version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
  ok: z.literal(true),
  status: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('pending') }),
    z.strictObject({
      state: z.literal('succeeded'),
      account: z.strictObject({ id: z.uuid(), email: z.email() }),
    }),
    z.strictObject({ state: z.literal('failed'), message: z.string().max(200) }),
  ]),
});

export const OAuthErrorResponseSchema = z.strictObject({
  version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
  ok: z.literal(false),
  code: z.enum([
    'NOT_READY',
    'LOGIN_ACTIVE',
    'LOGIN_UNAVAILABLE',
    'UNKNOWN_SESSION',
    'INVALID_REQUEST',
  ]),
  message: z.string().max(200),
});

export type ManagementStatusResponse = z.infer<typeof ManagementStatusResponseSchema>;
export type ManagementShutdownResponse = z.infer<typeof ManagementShutdownResponseSchema>;
export type ManagementResponse = ManagementStatusResponse | ManagementShutdownResponse;
export type OAuthStartRequest = z.infer<typeof OAuthStartRequestSchema>;
export type OAuthCompleteRequest = z.infer<typeof OAuthCompleteRequestSchema>;
export type OAuthCompleteResponse = z.infer<typeof OAuthCompleteResponseSchema>;
export type OAuthStartResponse = z.infer<typeof OAuthStartResponseSchema>;
export type OAuthStatusResponse = z.infer<typeof OAuthStatusResponseSchema>;
export type OAuthCancelResponse = z.infer<typeof OAuthCancelResponseSchema>;
export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseSchema>;
