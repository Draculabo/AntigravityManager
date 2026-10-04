import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectAuditWindow } from './audit-window.mjs';
import { evaluateRun, summarizeRequests } from './summarize.mjs';
import { z } from 'zod';

const reportSchema = z.object({
  platform: z.string(),
  ownerDeclared: z.string(),
  client: z.string(),
  claudeSystemPrompt: z.enum(['default', 'compact']).nullable().optional(),
  claudeMaxOutputTokens: z.number().nullable().optional(),
  clientVersion: z.string().nullable().optional(),
  verdict: z.object({ passed: z.boolean(), failures: z.array(z.string()) }),
  artifactBytes: z.number().nullable(),
  audit: z.object({
    requests: z.array(z.object({ protocol: z.string(), route: z.string() })),
    count: z.number().int(),
    successfulCount: z.number().int(),
    upstream429Attempts: z.number().int(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
  }),
  events: z.object({ toolStates: z.record(z.string(), z.number()) }),
  thought: z.object({ writeFailuresDelta: z.number(), reasoningTokensAvailable: z.boolean() }),
});

let reportPaths = process.argv.slice(2);
if (reportPaths[0] === '--refresh') {
  const [, profileHome, ...sources] = reportPaths;
  assert(
    profileHome && sources.length,
    'Usage: npm run test:acceptance -- agents report --refresh PROFILE_HOME REPORT...',
  );
  reportPaths = await refreshReports(profileHome, sources);
}
assert(reportPaths.length, 'Pass one or more report.json paths');
const rows = await Promise.all(
  reportPaths.map(async (file) => {
    const report = reportSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    const toolCount = Object.values(report.events.toolStates).reduce(
      (sum, value) => sum + value,
      0,
    );
    return {
      platform: report.platform,
      owner: report.ownerDeclared,
      client: `${report.clientVersion ?? report.client}${report.claudeSystemPrompt === 'compact' ? ' (compact system)' : ''}${report.claudeMaxOutputTokens ? ` (max ${report.claudeMaxOutputTokens})` : ''}`,
      gatewayPath: [
        ...new Set(report.audit.requests.map((request) => `${request.protocol} ${request.route}`)),
      ].join(', '),
      result: report.verdict.passed ? 'PASS' : `FAIL: ${report.verdict.failures.join(', ')}`,
      requests: `${report.audit.successfulCount}/${report.audit.count}`,
      upstream429: report.audit.upstream429Attempts,
      tools: toolCount,
      inputTokens: report.audit.inputTokens ?? 'unknown',
      outputTokens: report.audit.outputTokens ?? 'unknown',
      thought:
        report.thought.writeFailuresDelta > 0
          ? 'write failure'
          : report.thought.reasoningTokensAvailable
            ? 'reported'
            : 'not reported',
      artifactBytes: report.artifactBytes ?? 'missing',
    };
  }),
);
rows.sort((left, right) =>
  `${left.platform}/${left.owner}/${left.client}`.localeCompare(
    `${right.platform}/${right.owner}/${right.client}`,
  ),
);
console.log(
  '| Platform | Owner | Client | Gateway path | Result | Final 2xx / requests | Upstream 429 | Tools | Input tokens | Output tokens | Reasoning | HTML bytes |',
);
console.log('| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |');
for (const row of rows) {
  console.log(
    `| ${Object.values(row)
      .map((value) => String(value).replaceAll('|', '\\|'))
      .join(' | ')} |`,
  );
}

async function refreshReports(profileHome, reportPaths) {
  const refreshed = [];
  const config = JSON.parse(
    await fs.readFile(path.join(profileHome, '.antigravity-agent', 'gui_config.json'), 'utf8'),
  );
  for (const reportPath of reportPaths) {
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    const gateway = new URL(report.gateway);
    assert(
      gateway.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname),
      'Only a local acceptance gateway can be reconciled',
    );
    const getJson = async (route, schema) => {
      const response = await fetch(`${gateway.origin}${route}`, {
        headers: { authorization: `Bearer ${config.proxy.api_key}` },
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200, 'Acceptance audit diagnostics must be available');
      return schema.parse(await response.json());
    };
    const protocols = { claude: 'anthropic', codex: 'openai-responses', opencode: 'openai' };
    const { details } = await collectAuditWindow({
      getJson,
      ...report,
      protocol: protocols[report.client],
    });
    const audit = summarizeRequests(details);
    const verdict = evaluateRun({
      ...report,
      audit,
      thoughtWriteFailuresDelta: report.thought.writeFailuresDelta,
    });
    const target = path.join(path.dirname(reportPath), 'report.reconciled.json');
    await fs.writeFile(
      target,
      JSON.stringify(
        {
          ...report,
          audit,
          verdict,
          reconciliation: {
            originalReport: path.basename(reportPath),
            previousRequestCount: report.audit.count,
            completeModelWindow: true,
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    refreshed.push(target);
    console.log(
      JSON.stringify({
        reportPath: target,
        previousRequests: report.audit.count,
        requests: audit.count,
        passed: verdict.passed,
        failures: verdict.failures,
      }),
    );
  }

  return refreshed;
}
