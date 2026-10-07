import semver from 'semver';
import { z } from 'zod';

export const RELEASE_NOTES_LIMIT = 256 * 1024;

export const ReleaseTagSchema = z
  .string()
  .max(128)
  .refine((tag) => tag.startsWith('v') && semver.valid(tag.slice(1)) !== null);

export const ReleaseNotesTargetSchema = z.strictObject({ tagName: ReleaseTagSchema });
export type ReleaseNotesTarget = z.infer<typeof ReleaseNotesTargetSchema>;

const publishedAt = z.iso.datetime().nullable();
export const ReleaseNotesResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    tagName: ReleaseTagSchema,
    notes: z.string().max(RELEASE_NOTES_LIMIT),
    publishedAt,
  }),
  z.strictObject({ status: z.literal('empty'), tagName: ReleaseTagSchema, publishedAt }),
  z.strictObject({ status: z.literal('error'), tagName: ReleaseTagSchema }),
]);
export type ReleaseNotesResult = z.infer<typeof ReleaseNotesResultSchema>;

export const ReleaseNotesMetadataSchema = z.object({
  version: z.string().max(128),
  notes: z.string().max(RELEASE_NOTES_LIMIT).optional(),
  pub_date: z.iso.datetime().optional(),
});

export const GitHubReleaseNotesSchema = z.object({
  tag_name: ReleaseTagSchema,
  body: z.string().max(RELEASE_NOTES_LIMIT).nullable(),
  published_at: publishedAt,
  draft: z.boolean(),
});

export const ReleaseNotesLinkSchema = z.strictObject({ url: z.string().min(1).max(2048) });
export const ReleaseNotesLinkResultSchema = z.strictObject({ status: z.enum(['opened', 'error']) });
