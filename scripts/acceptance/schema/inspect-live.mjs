import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
const database = new DatabaseSync(
  path.join(os.homedir(), '.antigravity-agent/proxy-state/request-audit.db'),
  { readOnly: true },
);
function body(payloadId) {
  const descriptor = database
    .prepare('SELECT state,logical_bytes FROM audit_payloads WHERE id=?')
    .get(payloadId);
  if (descriptor?.state !== 'complete' || descriptor.logical_bytes > 2 * 1024 * 1024) {
    return undefined;
  }
  const chunks = database
    .prepare('SELECT payload,encoding FROM audit_payload_chunks WHERE payload_id=? ORDER BY seq')
    .all(payloadId);
  if (chunks.some((chunk) => chunk.encoding !== 'raw')) {
    return undefined;
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.payload))).toString('utf8'),
    );
  } catch {
    return undefined;
  }
}
const requests = database
  .prepare(
    "SELECT id,status FROM request_logs WHERE request_headers LIKE '%x-schema-acceptance%' ORDER BY timestamp DESC LIMIT 4",
  )
  .all();
const output = [];
for (const request of requests) {
  const attempts = database
    .prepare(
      'SELECT id,model,status,endpoint,request_headers FROM upstream_attempts WHERE parent_id=? ORDER BY attempt_index',
    )
    .all(request.id);
  for (const attempt of attempts) {
    const refs = database
      .prepare('SELECT direction,payload_id FROM attempt_body_refs WHERE attempt_id=?')
      .all(attempt.id);
    const incoming = body(refs.find((ref) => ref.direction === 'request')?.payload_id);
    const outgoing = body(refs.find((ref) => ref.direction === 'response')?.payload_id);
    const inner = incoming?.request ?? incoming;
    const response = outgoing?.response ?? outgoing;
    try {
      const headers = JSON.parse(attempt.request_headers);
      const value = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === 'user-agent',
      )?.[1];
      output.push({
        headerUserAgent:
          typeof value === 'string' && /^antigravity\/\d+\.\d+\.\d+ [a-z]+\/[a-z0-9]+$/.test(value)
            ? value
            : undefined,
      });
    } catch {
      /* No header values are exported unless they match the fixed public format. */
    }
    const texts =
      response?.candidates?.flatMap(
        (candidate) =>
          candidate.content?.parts?.flatMap((part) =>
            typeof part.text === 'string' ? [part.text] : [],
          ) ?? [],
      ) ?? [];
    output.push({
      retiredFlashNotice: texts.some(
        (text) =>
          text.trim() ===
          'Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.',
      ),
      versionOrUpdateNotice: texts.some((text) => /version|update|outdated|supported/i.test(text)),
      versionWord: texts.some((text) => /\bversion\b/i.test(text)),
      antigravityWord: texts.some((text) => /antigravity/i.test(text)),
      modelWord: texts.some((text) => /\bmodel\b/i.test(text)),
      quotaOrUpgradeNotice: texts.some((text) =>
        /quota|upgrade|subscription|paid|exhausted/i.test(text),
      ),
      userAgent:
        typeof incoming?.userAgent === 'string' &&
        /^antigravity\/\d+\.\d+\.\d+ [a-z]+\/[a-z0-9]+$/.test(incoming.userAgent)
          ? incoming.userAgent
          : undefined,
    });
    let endpointOrigin;
    try {
      endpointOrigin = new URL(attempt.endpoint).origin;
    } catch {
      endpointOrigin = 'unknown';
    }
    output.push({
      endpointOrigin,
      textBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      exactOk: texts.length > 0 && texts.every((text) => text.trim().toLowerCase() === 'ok'),
      mentionsProbe: texts.some((text) => text.includes('probe_read')),
      structuredText: texts.some((text) => /^\s*[{[]/.test(text)),
    });
    const declarations = inner?.tools?.flatMap((tool) => tool.functionDeclarations ?? []) ?? [];
    output.push({
      status: attempt.status,
      model: attempt.model,
      requestType: incoming?.requestType,
      declarationCount: declarations.length,
      hasProbe: declarations.some((tool) => tool.name === 'probe_read'),
      parameters: declarations.find((tool) => tool.name === 'probe_read')?.parameters,
      toolConfig: inner?.toolConfig,
      snakeToolConfig: inner?.tool_config,
      generation: inner?.generationConfig
        ? {
            maxOutputTokens: inner.generationConfig.maxOutputTokens,
            thinkingConfig: inner.generationConfig.thinkingConfig,
          }
        : undefined,
      candidates: response?.candidates?.map((candidate) => ({
        finishReason: candidate.finishReason,
        parts: candidate.content?.parts?.map((part) => ({
          functionCall: Boolean(part.functionCall),
          serverTool: Boolean(part.serverSideToolInvocation || part.toolCall),
          text: typeof part.text === 'string',
          thought: part.thought === true,
          refusalOrNoAccess:
            typeof part.text === 'string' &&
            /cannot|can't|do not have access|unable/i.test(part.text),
        })),
      })),
    });
  }
}
database.close();
process.stdout.write(`${JSON.stringify(output)}\n`);
