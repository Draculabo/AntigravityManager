import { ORPCError } from '@orpc/client';
import { type Command, Option } from 'commander';
import { z, type ZodType } from 'zod';
import type { DshOperations } from '@/modules/proxy-gateway/dsh-sync/dsh-owner.service';
import {
  DshErrorCodeSchema,
  DshPreviewInputSchema,
  DshPreviewSchema,
  DshProfileInputSchema,
  DshRemoveInputSchema,
  DshStatusSchema,
  DshSyncInputSchema,
  DshWriteResultSchema,
} from '@/modules/proxy-gateway/dsh-sync/dsh-owner.schema';
import type { CliOutput } from './app';

type ProfileFlags = { profile: string };
type SyncFlags = {
  protocol?: string;
  baseUrl?: string;
  credentialMode?: string;
  credentialRef?: string;
  model?: string[];
  activateModel?: string;
};
type SourceHashFlags = { sourceHash: string; yes: true };

const errorData = z.strictObject({ dshCode: DshErrorCodeSchema });
const errorHints = {
  unavailable: 'Check that the standalone Manager Core is available and try again.',
  'home-missing': 'Set DSH_HOME for the standalone Manager Core.',
  'read-failed': 'Check that the DSH profile patch is accessible to the standalone Manager Core.',
  'invalid-config': 'Check the selected DSH profile and its credential reference.',
  conflict: 'Review a fresh preview before retrying.',
  'write-failed': 'Inspect the current DSH settings before retrying.',
  'receipt-failed':
    'DSH settings may have changed. Inspect the profile and its credentials before retrying.',
  'operation-failed': 'Check the current DSH settings before retrying.',
} satisfies Record<z.infer<typeof DshErrorCodeSchema>, string>;

function operationMessage(error: unknown): string {
  const parsed = errorData.safeParse(error instanceof ORPCError ? error.data : undefined);
  const code = parsed.success ? parsed.data.dshCode : 'operation-failed';
  return `DSH operation failed (${code}). ${errorHints[code]}`;
}

function addSyncFlags(command: Command): Command {
  // Optional Commander arguments leave a following flag unconsumed. The input schema still
  // requires a value when the option is supplied, and --model=<id> can spell dash-prefixed IDs.
  return command
    .option('--protocol <name>', 'openai-completions, openai-responses, or anthropic-messages')
    .option('--base-url <url>', 'Manager gateway URL')
    .option('--credential-ref <name>', 'DSH environment-variable reference name')
    .addOption(
      new Option('--model [id]', 'Model ID to include (value required, repeatable)')
        .preset('')
        .argParser((id: string, ids: string[] = []) => [...ids, id]),
    )
    .option('--activate-model [id]', 'Set a listed model as the default (value required)')
    .option('--credential-mode <mode>', 'existing-reference (default) or manager-key');
}

export function registerDshCommands(
  tools: Command,
  start: () => Promise<unknown>,
  output: CliOutput,
  client?: DshOperations,
): void {
  const dsh = tools
    .command('dsh')
    .description('Review and update a DSH profile through the standalone Manager Core')
    .allowExcessArguments(false)
    .configureOutput({ outputError: (_, write) => write('Invalid DSH command options.\n') })
    .showHelpAfterError('Run antigravity-manager tools dsh --help for usage.');
  const profile = (name: string, description: string) =>
    dsh
      .command(name)
      .description(description)
      .requiredOption('--profile <name>', 'DSH profile name');
  const confirm = (command: Command) =>
    command
      .requiredOption('--source-hash <hash>', 'Source hash from the reviewed preview')
      .requiredOption('--yes', 'Confirm the settings change');

  async function run<Input, Result>(
    input: Input,
    resultSchema: ZodType<Result>,
    operation: (owner: DshOperations, input: Input) => Promise<Result>,
  ) {
    if (!client) {
      throw new Error('DSH settings are unavailable.');
    }
    try {
      await start();
    } catch {
      throw new Error(
        'Could not start or connect to the standalone Manager Core. Check service status and profile ownership.',
      );
    }
    let result: Result;
    try {
      result = resultSchema.parse(await operation(client, input));
    } catch (error) {
      throw new Error(operationMessage(error));
    }
    output.stdout(`${JSON.stringify(result)}\n`);
  }

  profile('status', 'Show the DSH profile patch status').action(async (flags: ProfileFlags) => {
    const input = DshProfileInputSchema.safeParse(flags);
    if (!input.success) {
      throw new Error('Provide a valid DSH --profile name.');
    }
    await run(input.data, DshStatusSchema, (owner, value) => owner.status(value));
  });

  addSyncFlags(
    profile('preview', 'Review the planned DSH sync or removal').requiredOption(
      '--action <action>',
      'sync or remove',
    ),
  ).action(async ({ model, ...flags }: ProfileFlags & SyncFlags & { action: string }) => {
    const input = DshPreviewInputSchema.safeParse({
      ...flags,
      ...(model && { models: model }),
    });
    if (!input.success) {
      throw new Error(
        'Provide a valid DSH --profile and --action. A sync preview requires --protocol, --base-url, --credential-ref, and --model. A remove preview accepts only --profile and --action.',
      );
    }
    await run(input.data, DshPreviewSchema, (owner, value) => owner.preview(value));
  });

  confirm(addSyncFlags(profile('apply', 'Apply a reviewed DSH sync'))).action(
    async ({ model, sourceHash, yes: _, ...flags }: ProfileFlags & SyncFlags & SourceHashFlags) => {
      const input = DshSyncInputSchema.safeParse({
        ...flags,
        action: 'sync',
        models: model,
        expectedSourceHash: sourceHash,
      });
      if (!input.success) {
        throw new Error(
          'Provide a valid DSH --profile, --protocol, --base-url, --credential-ref, --model, and --source-hash from preview.',
        );
      }
      await run(input.data, DshWriteResultSchema, (owner, value) => owner.sync(value));
    },
  );

  confirm(profile('remove', 'Apply a reviewed DSH removal')).action(
    async ({ profile, sourceHash }: ProfileFlags & SourceHashFlags) => {
      const input = DshRemoveInputSchema.safeParse({ profile, expectedSourceHash: sourceHash });
      if (!input.success) {
        throw new Error('Provide a valid DSH --profile and --source-hash from preview.');
      }
      await run(input.data, DshWriteResultSchema, (owner, value) => owner.remove(value));
    },
  );
}
