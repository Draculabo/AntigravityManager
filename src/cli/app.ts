import { Command, CommanderError } from 'commander';
import { readFinalizedOperationDiagnostic } from '@/shared/observability/operationDiagnostic';
import { formatOperationDiagnostic } from '@/shared/observability/operationDiagnosticText';
import { loginGoogleAccount } from './google-login';
import type { ServiceLauncher } from './service-launcher';
import type { ManagementClient } from '@/core/management/client';
import { registerAccountCommands, type AccountCommandClient } from './account-commands';
import {
  registerAgentToolsCommands,
  agentToolCommandError,
  type AgentToolsCommandClient,
} from './agent-tools-commands';

export interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function runCli(
  args: string[],
  launcher: Pick<ServiceLauncher, 'status' | 'start' | 'stop'>,
  output: CliOutput,
  oauth?: Pick<ManagementClient, 'startOAuth' | 'oauthStatus'>,
  accounts?: AccountCommandClient,
  tools?: AgentToolsCommandClient,
): Promise<number> {
  const command = new Command('antigravity-manager');
  command.description('Manage the standalone Antigravity Manager core service');
  command.exitOverride();
  command.configureOutput({ writeOut: output.stdout, writeErr: output.stderr });
  command.showHelpAfterError();
  const service = command.command('service').description('Control the local core service');
  let exitCode = 0;

  service
    .command('status')
    .description('Show the local core service state')
    .action(async () => {
      const status = await launcher.status();
      if (!status) {
        output.stdout('stopped\n');
        exitCode = 3;
        return;
      }
      output.stdout(
        `${status.state} pid=${status.pid} gateway=${status.gateway.running ? status.gateway.port : 'stopped'}\n`,
      );
    });

  service
    .command('start')
    .description('Start the local core service if it is not running')
    .action(async () => {
      const result = await launcher.start();
      output.stdout(
        `${result.alreadyRunning ? 'already running' : 'started'} pid=${result.status.pid}\n`,
      );
    });

  service
    .command('stop')
    .description('Gracefully stop the local core service')
    .action(async () => {
      const result = await launcher.stop();
      output.stdout(result.alreadyStopped ? 'already stopped\n' : 'stopped\n');
    });

  const account = command.command('account').description('Manage Google accounts');
  registerAgentToolsCommands(command, () => launcher.start(), output, tools);
  registerAccountCommands(account, () => launcher.start(), output, accounts);
  account
    .command('login')
    .description('Authorize a Google account through the standalone core')
    .action(async () => loginGoogleAccount(oauth, () => launcher.start(), output));

  try {
    await command.parseAsync(args, { from: 'user' });
    if (args.length === 0) {
      command.outputHelp();
    }
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.code === 'commander.helpDisplayed' ? 0 : 2;
    }
    output.stderr(
      `${agentToolCommandError(error) ?? (error instanceof Error ? error.message : 'Unknown CLI error')}\n`,
    );
    const diagnostic = readFinalizedOperationDiagnostic(error);
    if (diagnostic) {
      output.stderr(`${formatOperationDiagnostic(diagnostic)}\n`);
    }
    return 1;
  }
}
