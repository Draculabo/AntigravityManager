import { z } from 'zod';
import { CloudAccountIdSchema } from './cloud-account-mutation.schema';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';

export const OwnerNotificationLanguageSchema = z.enum(['en', 'zh-CN', 'ru', 'vi', 'fr', 'tr']);
export type OwnerNotificationLanguage = z.infer<typeof OwnerNotificationLanguageSchema>;
export const OwnerNotificationModelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const EventAccountIdSchema = CloudAccountIdSchema.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const AccountOwnerEventDraftSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('low-quota'),
    accountId: EventAccountIdSchema,
    language: OwnerNotificationLanguageSchema,
    models: z.array(OwnerNotificationModelSchema).min(1).max(16),
  }),
  z.strictObject({
    kind: z.literal('low-ai-credit'),
    accountId: EventAccountIdSchema,
    language: OwnerNotificationLanguageSchema,
    credits: z.number().finite().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('account-switched'),
    accountId: EventAccountIdSchema,
    target: AntigravityAppTargetSchema,
    reason: z.enum(['manual', 'auto']),
  }),
]);
export type AccountOwnerEventDraft = z.infer<typeof AccountOwnerEventDraftSchema>;
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AccountOwnerEventSchema = z.strictObject({
  sequence: SequenceSchema.min(1),
  event: AccountOwnerEventDraftSchema,
});
export type AccountOwnerEvent = z.infer<typeof AccountOwnerEventSchema>;
export const AccountOwnerEventReadInputSchema = z.strictObject({
  epoch: z.uuid().optional(),
  after: SequenceSchema.default(0),
});
export const AccountOwnerEventBatchSchema = z
  .strictObject({
    epoch: z.uuid(),
    latest: SequenceSchema,
    events: z.array(AccountOwnerEventSchema).max(32),
  })
  .refine((batch) =>
    batch.events.every(
      (item, index) =>
        item.sequence <= batch.latest &&
        (index === 0 || item.sequence > batch.events[index - 1].sequence),
    ),
  );
export type AccountOwnerEventBatch = z.infer<typeof AccountOwnerEventBatchSchema>;
