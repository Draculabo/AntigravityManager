import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { verifyLiveToolHistory } from './live-tool-history.mjs';
import {
  readLiveUpstreamEvidence,
  hasVerifiedSignatureRecovery,
} from './live-upstream-evidence.mjs';

// Prove the extended check catches a provider losing one result only on cross-model resubmission.
const workspace = fs.mkdtempSync(path.resolve('out/schema-work-package/history-control-'));
const result = {};
const http = async (_route, _body, label) => {
  const files = ['left', 'right'].map((side) => path.join(workspace, `${side}.txt`));
  if (label === 'history-parallel-call') {
    return {
      content: files.map((file_path, index) => ({
        type: 'tool_use',
        id: `controlled-${index}`,
        name: 'probe_read',
        input: { file_path },
      })),
    };
  }
  const markers = files.map((file) => fs.readFileSync(file, 'utf8'));
  return {
    content: [
      {
        type: 'text',
        text: label === 'history-crossModelResubmitted-result' ? markers[0] : markers.join('\n'),
      },
    ],
  };
};
let rejected = false;
try {
  await verifyLiveToolHistory({
    http,
    workspace,
    model: 'gemini-3.1-pro-high',
    result,
    extended: true,
  });
} catch (error) {
  rejected = error.message === 'Tool history comparison failed; see bounded variant evidence';
}
const evidence = {
  missingResultRejected: rejected,
  precedingVariantsAccepted: [
    'combined',
    'split',
    'reversedResults',
    'resubmittedSameModel',
    'crossModel',
  ].every((label) => result.toolHistory[label] === true),
  sameModelResubmissionIdentical: result.toolHistory.sameModelResubmissionIdentical,
  crossModelResubmissionIdentical: result.toolHistory.crossModelResubmissionIdentical,
  missingResultIdentified:
    result.toolHistory.crossModelResubmitted === false &&
    result.toolHistory.failures.length === 1 &&
    result.toolHistory.failures[0].variant === 'crossModelResubmitted',
};
const recoveryResult = {};
let recoveryRejected = false;
try {
  await verifyLiveToolHistory({
    workspace,
    model: 'gemini-3.1-pro-high',
    result: recoveryResult,
    recovery: true,
    http: async (route, body, label) => {
      const response = await http(route, body, label);
      if (label === 'history-parallel-call') {
        return {
          content: response.content.map((block) => ({
            ...block,
            signature: 'controlled-thought-signature',
          })),
        };
      }
      if (label === 'history-corruptedSignature-result') {
        return {
          content: [
            { type: 'text', text: fs.readFileSync(path.join(workspace, 'left.txt'), 'utf8') },
          ],
        };
      }
      return response;
    },
  });
} catch (error) {
  recoveryRejected =
    error.message === 'Tool history comparison failed; see bounded variant evidence';
}
evidence.failedRecoveryResultRejected =
  recoveryRejected && recoveryResult.toolHistory.signatureRecovery.resultMatched === false;
evidence.signatureCorruptionPreservesOtherFields =
  recoveryResult.toolHistory.signatureRecovery.signatureChanged &&
  recoveryResult.toolHistory.signatureRecovery.otherBlocksUnchanged;
const database = new DatabaseSync(':memory:');
try {
  database.exec(
    'CREATE TABLE request_logs (id TEXT, request_headers TEXT, model TEXT); CREATE TABLE upstream_attempts (parent_id TEXT, model TEXT, status INTEGER, timestamp INTEGER);',
  );
  const insert = database.prepare('INSERT INTO request_logs VALUES (?,?,?)');
  const headers = JSON.stringify({
    'x-schema-acceptance': 'controlled:history-crossModel-result',
    authorization: 'private-negative-control',
  });
  insert.run('private-parent-1', headers, 'gemini-3.7-flash-high');
  insert.run('private-parent-2', headers, 'gemini-3.7-flash-high');
  database.exec(
    "INSERT INTO upstream_attempts VALUES ('private-parent-1','gemini-3.7-flash-agent',400,1), ('private-parent-1','gemini-3.7-flash-agent',200,2), ('private-parent-2','gemini-3.7-flash-agent',200,3);",
  );
  const observed = readLiveUpstreamEvidence(database, 'controlled');
  const recoveryAttempts = observed
    .slice(0, 2)
    .map((attempt) => ({ ...attempt, label: 'history-corruptedSignature-result' }));
  evidence.recoveryAttemptSequenceAccepted = hasVerifiedSignatureRecovery(recoveryAttempts);
  evidence.missingRecoveryAuditRejected = !hasVerifiedSignatureRecovery([]);
  evidence.singleSuccessfulAttemptRejected = !hasVerifiedSignatureRecovery([
    { ...recoveryAttempts[0], status: 200, attemptCount: 1 },
  ]);
  evidence.attemptsGroupedByRequest =
    JSON.stringify(observed.map((item) => item.attemptCount)) === '[2,2,1]';
  evidence.statusSequencePreserved =
    JSON.stringify(observed.map((item) => item.status)) === '[400,200,200]';
  evidence.privateAuditContextAbsent =
    !/private-parent|private-negative-control|authorization|requestHeaders|parentId/.test(
      JSON.stringify(observed),
    );
} finally {
  database.close();
}
const liveFiles = process.argv.slice(2);
if (liveFiles.length > 0) {
  if (liveFiles.length !== 2) {
    throw new Error('Expected Flash recovery and inconclusive Pro record paths');
  }
  const Record = z.object({
    upstreamModels: z.array(
      z.object({
        status: z.number().nullable(),
        attemptCount: z.number().int().positive(),
        label: z.string().optional(),
      }),
    ),
    toolHistory: z.object({ signatureRecovery: z.object({ upstreamRetryVerified: z.boolean() }) }),
  });
  const records = liveFiles.map((file) => {
    if (fs.statSync(file).size > 1_048_576) {
      throw new Error('Anonymous history evidence is oversized');
    }
    return Record.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  });
  evidence.liveFlashRecoveryVerified =
    hasVerifiedSignatureRecovery(records[0].upstreamModels) &&
    records[0].toolHistory.signatureRecovery.upstreamRetryVerified;
  evidence.liveProSingleAttemptRemainsUnverified =
    !hasVerifiedSignatureRecovery(records[1].upstreamModels) &&
    !records[1].toolHistory.signatureRecovery.upstreamRetryVerified;
}
fs.writeFileSync(
  'artifacts/schema-work-package/history-evidence-sensitivity.json',
  `${JSON.stringify(evidence, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (Object.values(evidence).some((value) => value !== true)) {
  process.exitCode = 1;
}
