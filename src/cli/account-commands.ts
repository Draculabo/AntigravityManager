import { Command, Option } from 'commander';
import type { CoreRpcClient } from '@/core/rpc/client';
import { AntigravityAppTargetSchema } from '@/shared/platform/antigravityAppTarget';
import { z } from 'zod';
import type { CliOutput } from './app';

export type AccountCommandClient = Pick<
  CoreRpcClient,
  'accountViews' | 'switchCloudAccount' | 'accountSwitchStatus'
> & {
  localAccounts: Pick<
    CoreRpcClient['localAccounts'],
    'listAccounts' | 'switchAccount' | 'getCurrentAccountInfo' | 'addAccountSnapshot'
  >;
};

const sourceSchema = z.enum(['cloud', 'local']);
const targetOption = () =>
  new Option('--target <target>', 'Choose the client to switch')
    .choices(['classic', 'ide', 'agy'])
    .default('classic');
const sourceOption = () =>
  new Option('--source <source>', 'Choose saved Google accounts or local snapshots')
    .choices(['cloud', 'local'])
    .default('cloud');

/** Command parsing stays in the CLI; the selected core owns account credentials and switching. */
export function registerAccountCommands(
  account: Command,
  start: () => Promise<unknown>,
  output: CliOutput,
  client?: AccountCommandClient,
): void {
  function requireClient(): AccountCommandClient {
    if (!client) {
      throw new Error(
        'Account actions are unavailable. Restart Antigravity Manager and try again.',
      );
    }
    return client;
  }

  account
    .command('list')
    .description('List saved accounts')
    .addOption(sourceOption())
    .action(async (options: { source: string }) => {
      const source = sourceSchema.parse(options.source);
      const owner = requireClient();
      await start();
      const accounts =
        source === 'cloud' ? await owner.accountViews() : await owner.localAccounts.listAccounts();
      output.stdout(`${JSON.stringify(accounts)}\n`);
    });
  account
    .command('current')
    .description('Show the account saved in the selected client')
    .addOption(targetOption())
    .action(async (options: { target: string }) => {
      const target = AntigravityAppTargetSchema.parse(options.target);
      const owner = requireClient();
      await start();
      output.stdout(`${JSON.stringify(await owner.localAccounts.getCurrentAccountInfo(target))}\n`);
    });
  account
    .command('snapshot')
    .description('Save the selected client account for later switching')
    .addOption(targetOption())
    .action(async (options: { target: string }) => {
      const target = AntigravityAppTargetSchema.parse(options.target);
      const owner = requireClient();
      await start();
      output.stdout(`${JSON.stringify(await owner.localAccounts.addAccountSnapshot(target))}\n`);
    });
  account
    .command('switch <account-id>')
    .description('Switch a client to a saved account')
    .addOption(targetOption())
    .addOption(sourceOption())
    .action(async (id: string, options: { target: string; source: string }) => {
      const target = AntigravityAppTargetSchema.parse(options.target);
      const source = sourceSchema.parse(options.source);
      const owner = requireClient();
      await start();
      if (source === 'cloud') {
        await owner.switchCloudAccount(id, target);
      } else {
        await owner.localAccounts.switchAccount(id, target);
      }
      output.stdout(`Account switched successfully: ${target}\n`);
    });
  account
    .command('switch-status')
    .description('Show account switching results')
    .action(async () => {
      const owner = requireClient();
      await start();
      output.stdout(`${JSON.stringify(await owner.accountSwitchStatus())}\n`);
    });
}
