import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Command, Option } from 'commander';
import { z } from 'zod';
import { collectAuditWindow } from '../agents/audit-window.mjs';
import {
  evaluateThinking,
  followUpRequest,
  initialRequest,
  inspectResponse,
} from './protocols.mjs';

const options = new Command()
  .description(
    'Run a two-turn thinking and tool-continuation check against an isolated live gateway.',
  )
  .addOption(
    new Option('--protocol <protocol>')
      .choices(['openai', 'anthropic', 'gemini'])
      .makeOptionMandatory(),
  )
  .addOption(new Option('--owner <owner>').choices(['cli', 'electron']).makeOptionMandatory())
  .requiredOption('--gateway <origin>')
  .option('--profile-home <directory>', 'Prepared isolated profile', os.homedir())
  .option('--output <directory>', 'Safe report directory', 'out/live-thinking-acceptance')
  .option('--model <model>', 'Gateway model ID', 'gemini-3.1-pro-high')
  .parse()
  .opts();
const gateway = new URL(options.gateway);
if (
  gateway.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname) ||
  gateway.pathname !== '/' ||
  gateway.search ||
  gateway.hash ||
  gateway.username ||
  gateway.password
) {
  throw new Error('Gateway must be a loopback HTTP origin');
}
z.string()
  .regex(/^[a-zA-Z0-9._-]{1,100}$/)
  .parse(options.model);
const statsSchema = z.object({
  writeFailures: z.number().int().nonnegative(),
  workerAlive: z.boolean(),
});

async function main() {
  const config = z
    .object({ proxy: z.object({ api_key: z.string().min(1) }) })
    .parse(
      JSON.parse(
        await fs.readFile(
          path.join(options.profileHome, '.antigravity-agent/gui_config.json'),
          'utf8',
        ),
      ),
    );
  const headers = {
    authorization: `Bearer ${process.env.AGM_ACCEPTANCE_API_KEY ?? config.proxy.api_key}`,
  };
  const getJson = async (route, schema) => {
    const response = await fetch(`${gateway.origin}${route}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error('Gateway diagnostics unavailable');
    }
    return schema.parse(await response.json());
  };
  const before = await getJson('/internal/thinking/stats', statsSchema);
  const request = initialRequest(options.protocol, options.model);
  const responses = [];
  const httpStatuses = [];
  const startedAt = Date.now();
  let failure = null;
  const send = async (body) => {
    const response = await fetch(`${gateway.origin}${request.route}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    httpStatuses.push(response.status);
    if (!response.ok) {
      await response.arrayBuffer();
      throw new Error('model-http-failure');
    }
    return inspectResponse(options.protocol, await response.json());
  };
  try {
    responses.push(await send(request.body));
    responses.push(await send(followUpRequest(options.protocol, request, responses[0])));
  } catch (error) {
    // Parser and transport exceptions can contain provider payloads; only fixed categories are exported.
    failure = error.name === 'TimeoutError' ? 'model-timeout' : 'model-or-tool-continuation-failed';
  }
  const endedAt = Date.now();
  await delay(1500);
  const after = await getJson('/internal/thinking/stats', statsSchema);
  const { details } = await collectAuditWindow({
    getJson,
    startedAt,
    endedAt,
    protocol: options.protocol,
  });
  const audit = details.filter(
    (item) => new URL(item.request.url, gateway).pathname === request.route,
  );
  const verdict = evaluateThinking({
    responses,
    audit,
    writeFailuresDelta: after.writeFailures - before.writeFailures,
    workerAlive: after.workerAlive,
  });
  if (failure) {
    verdict.failures.push(failure);
    verdict.passed = false;
  }
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    ownerDeclared: options.owner,
    protocol: options.protocol,
    model: options.model,
    startedAt,
    durationMs: endedAt - startedAt,
    httpStatuses,
    turns: responses.map((item) => ({
      toolCalls: item.calls.length,
      thoughtBlocks: item.thoughtBlocks,
      thoughtBytes: item.thoughtBytes,
      correctAnswer: item.text.trim() === '391',
    })),
    audit: audit.map((item) => ({
      ...item.request,
      clientIp: undefined,
      url: request.route,
      attemptStatuses: item.attempts.map((attempt) => attempt.status),
    })),
    thought: {
      workerAlive: after.workerAlive,
      writeFailuresDelta: after.writeFailures - before.writeFailures,
    },
    verdict,
  };
  const directory = path.resolve(options.output);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(
    directory,
    `${options.protocol}-${options.owner}-${Date.now()}.json`,
  );
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ reportPath, passed: verdict.passed, failures: verdict.failures }));
  process.exitCode = verdict.passed ? 0 : 1;
}

main().catch(() => {
  console.error('Thinking acceptance diagnostics failed; no provider payload was exported.');
  process.exitCode = 1;
});
