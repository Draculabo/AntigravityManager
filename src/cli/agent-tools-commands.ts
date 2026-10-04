import type { Command } from 'commander';
import type { CliOutput } from './app';
import type { AgentToolsOperations } from '@/modules/proxy-gateway/agent-tools/agent-tools.service';
import {
  AgentToolConfigureSchema,
  AgentToolErrorCodeSchema,
  AgentToolSchema,
  AgentToolStatusInputSchema,
} from '@/modules/proxy-gateway/agent-tools/agent-tools.schema';
import type { OpenCodeOperations } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';

export interface AgentToolsCommandClient {
  agentTools: AgentToolsOperations;
  openCode: OpenCodeOperations;
}
export function registerAgentToolsCommands(
  command: Command,
  start: () => Promise<unknown>,
  output: CliOutput,
  client?: AgentToolsCommandClient,
) {
  const tools = command
    .command('tools')
    .description('Configure coding tools to use Antigravity Manager');
  const ready = async () => {
    if (!client) {
      throw new Error('Tool settings are unavailable.');
    }
    await start();
    return client;
  };
  tools
    .command('status <tool>')
    .requiredOption('--base-url <url>', 'Manager service address')
    .action(async (tool: string, options: { baseUrl: string }) => {
      const selectedTool = tool === 'opencode' ? tool : AgentToolSchema.parse(tool);
      const baseUrl = AgentToolStatusInputSchema.shape.baseUrl.parse(options.baseUrl);
      const owner = await ready();
      const result =
        selectedTool === 'opencode'
          ? await owner.openCode.status(baseUrl)
          : await owner.agentTools.status(selectedTool, baseUrl);
      output.stdout(`${JSON.stringify(result)}\n`);
    });
  tools
    .command('configure <tool>')
    .requiredOption('--base-url <url>', 'Manager service address')
    .requiredOption('--model <id>', 'Available model to use')
    .action(async (tool: string, options: { baseUrl: string; model: string }) => {
      const selectedTool = tool === 'opencode' ? tool : AgentToolSchema.parse(tool);
      const baseUrl = AgentToolStatusInputSchema.shape.baseUrl.parse(options.baseUrl);
      const model = AgentToolConfigureSchema.shape.model.parse(options.model);
      const owner = await ready();
      if (selectedTool === 'opencode') {
        await owner.openCode.sync({ baseUrl, models: [{ id: model }] });
      } else {
        await owner.agentTools.configure({ tool: selectedTool, baseUrl, model });
      }
      output.stdout('Configuration saved. Reopen the tool to use the new settings.\n');
    });
  for (const action of ['restore', 'remove'] as const) {
    tools
      .command(`${action} <tool>`)
      .description(
        action === 'restore'
          ? 'Replace tool settings with the original backup'
          : 'Remove the Manager connection and keep unrelated settings',
      )
      .option('--yes', 'Confirm the settings change')
      .option('--base-url <url>', 'Manager address (required to remove OpenCode connection)')
      .action(async (tool: string, options: { yes?: boolean; baseUrl?: string }) => {
        const selectedTool = tool === 'opencode' ? tool : AgentToolSchema.parse(tool);
        if (!options.yes) {
          throw new Error(
            'This changes the tool settings. Review the operation and pass --yes to confirm.',
          );
        }
        const baseUrl = options.baseUrl
          ? AgentToolStatusInputSchema.shape.baseUrl.parse(options.baseUrl)
          : undefined;
        if (selectedTool === 'opencode' && action === 'remove' && !baseUrl) {
          throw new Error('Provide --base-url to remove the OpenCode connection.');
        }
        const owner = await ready();
        if (selectedTool === 'opencode') {
          if (action === 'restore') {
            await owner.openCode.restore();
          } else {
            if (!baseUrl) {
              throw new Error('Provide --base-url to remove the OpenCode connection.');
            }
            await owner.openCode.clear({ baseUrl, clearLegacy: false });
          }
        } else {
          await owner.agentTools[action](selectedTool);
        }
        output.stdout('Settings updated. Reopen the tool.\n');
      });
  }
}

/** Error codes are safe for terminal output; configuration and credentials are not. */
export function agentToolCommandError(error: unknown): string | null {
  if (
    error &&
    typeof error === 'object' &&
    'data' in error &&
    error.data &&
    typeof error.data === 'object' &&
    'agentToolCode' in error.data
  ) {
    const result = AgentToolErrorCodeSchema.safeParse(error.data.agentToolCode);
    if (result.success) {
      return `Tool settings could not be updated (${result.data}). No credentials were printed.`;
    }
  }
  return null;
}
