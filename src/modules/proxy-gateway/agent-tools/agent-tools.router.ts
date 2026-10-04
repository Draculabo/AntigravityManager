import { ORPCError, os } from '@orpc/server';
import {
  AgentToolConfigureSchema,
  AgentToolError,
  AgentToolErrorCodeSchema,
  AgentToolInputSchema,
  AgentToolPreviewSchema,
  AgentToolResultSchema,
  AgentToolStatusInputSchema,
  AgentToolStatusSchema,
} from './agent-tools.schema';
import type { AgentToolsOperations } from './agent-tools.service';

async function operation<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const remote =
      error instanceof ORPCError
        ? AgentToolErrorCodeSchema.safeParse(error.data?.agentToolCode)
        : null;
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Could not update the tool settings. Please try again.',
      data: {
        agentToolCode:
          error instanceof AgentToolError
            ? error.code
            : remote?.success
              ? remote.data
              : 'unavailable',
      },
    });
  }
}
export function createAgentToolsRouter(owner: AgentToolsOperations) {
  return os.router({
    status: os
      .input(AgentToolStatusInputSchema)
      .output(AgentToolStatusSchema)
      .handler(({ input }) => operation(() => owner.status(input.tool, input.baseUrl))),
    configure: os
      .input(AgentToolConfigureSchema)
      .output(AgentToolResultSchema)
      .handler(({ input }) => operation(() => owner.configure(input))),
    preview: os
      .input(AgentToolInputSchema)
      .output(AgentToolPreviewSchema)
      .handler(({ input }) => operation(() => owner.preview(input.tool))),
    restore: os
      .input(AgentToolInputSchema)
      .output(AgentToolResultSchema)
      .handler(({ input }) => operation(() => owner.restore(input.tool))),
    remove: os
      .input(AgentToolInputSchema)
      .output(AgentToolResultSchema)
      .handler(({ input }) => operation(() => owner.remove(input.tool))),
  });
}
