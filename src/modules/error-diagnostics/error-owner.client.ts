import {
  ErrorOpenInputSchema,
  ErrorOpenSchema,
  ErrorOwnerStatusSchema,
} from './error-owner.schema';
import {
  ContentChunkSchema,
  ContentClosedSchema,
  ContentIdentitySchema,
  ContentReadInputSchema,
  type ContentReadInput,
  type ContentIdentity,
  type ContentChunk,
} from '@/shared/observability/content-capability.schema';
import {
  ErrorWindowClearSchema,
  ErrorWindowPageSchema,
  ErrorWindowQuerySchema,
} from './error-window.schema';
import type { ErrorDiagnosticOperations } from './error-owner.service';
import { z } from 'zod';

/** The selected private RPC owns transport; every reply is validated here. */
export function createErrorDiagnosticClient(
  transport: Omit<ErrorDiagnosticOperations, 'readContent' | 'closeContent'> & {
    readContent(input: ContentReadInput & { kind: 'error' }): Promise<ContentChunk>;
    closeContent(input: ContentIdentity & { kind: 'error' }): Promise<{ closed: true }>;
  },
): ErrorDiagnosticOperations {
  return {
    status: async () => ErrorOwnerStatusSchema.parse(await transport.status()),
    query: async (input) =>
      ErrorWindowPageSchema.parse(await transport.query(ErrorWindowQuerySchema.parse(input))),
    open: async (input) =>
      ErrorOpenSchema.nullable().parse(await transport.open(ErrorOpenInputSchema.parse(input))),
    readContent: async (input) =>
      ContentChunkSchema.parse(
        await transport.readContent(
          ContentReadInputSchema.extend({ kind: z.literal('error') }).parse(input),
        ),
      ),
    closeContent: async (input) =>
      ContentClosedSchema.parse(
        await transport.closeContent(
          ContentIdentitySchema.extend({ kind: z.literal('error') }).parse(input),
        ),
      ),
    clear: async () => ErrorWindowClearSchema.parse(await transport.clear()),
  };
}
