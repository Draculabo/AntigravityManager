import { os } from '@orpc/server';
import { shell } from 'electron';
import {
  ReleaseNotesLinkResultSchema,
  ReleaseNotesLinkSchema,
  ReleaseNotesResultSchema,
  ReleaseNotesTargetSchema,
} from '../../update/releaseNotes.schema';
import { isReleaseNotesLink } from '../../update/releaseNotesLinks';
import { getReleaseNotes } from '../../update/releaseNotesService';

export const releaseNotes = os
  .input(ReleaseNotesTargetSchema)
  .output(ReleaseNotesResultSchema)
  .handler(({ input, signal }) => getReleaseNotes(input, signal));

export const openReleaseNotesLink = os
  .input(ReleaseNotesLinkSchema)
  .output(ReleaseNotesLinkResultSchema)
  .handler(async ({ input }) => {
    if (!isReleaseNotesLink(input.url)) {
      return { status: 'error' };
    }
    try {
      await shell.openExternal(input.url);
      return { status: 'opened' };
    } catch {
      return { status: 'error' };
    }
  });
