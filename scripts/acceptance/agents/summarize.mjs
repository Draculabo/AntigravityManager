import path from 'node:path';

export const taskId = 'todo-html-v1';

export const taskPrompt = [
  'In this empty workspace, create a single standalone file named todo.html.',
  'Build a usable TODO List with add, mark complete, delete, and localStorage persistence.',
  'Use only inline HTML, CSS and JavaScript, with no external assets or network calls.',
  'Use accessible labels and semantic HTML.',
  'Actually write the file, then inspect the result. Finish with a short summary.',
].join(' ');

export function summarizeEvents(client, stdout, workspace = null) {
  const eventTypes = {};
  const toolStates = {};
  let clientErrorEvents = 0;
  let clientReportedError = false;
  let finalMessageObserved = false;
  const writeTargets = { inWorkspace: 0, outsideWorkspace: 0, unknown: 0 };
  const errorClasses = { socket: 0, quota: 0, rateLimit: 0, other: 0 };

  for (const line of stdout.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      continue;
    }
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
    if (event.type === 'error') {
      clientErrorEvents += 1;
      const message = String(event.error?.message ?? event.message ?? '').toLowerCase();
      const kind = message.includes('socket')
        ? 'socket'
        : message.includes('quota')
          ? 'quota'
          : message.includes('429') || message.includes('rate limit')
            ? 'rateLimit'
            : 'other';
      errorClasses[kind] += 1;
    }

    if (client === 'claude') {
      if (event.type === 'result') {
        finalMessageObserved = true;
        clientReportedError = event.is_error === true;
      }
      for (const block of event.message?.content ?? []) {
        if (block?.type === 'tool_use') {
          toolStates[block.name ?? 'unknown'] = (toolStates[block.name ?? 'unknown'] ?? 0) + 1;
        }
      }
    } else if (client === 'codex') {
      if (event.type === 'turn.completed') {
        finalMessageObserved = true;
      }
      if (event.type === 'turn.failed') {
        clientReportedError = true;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        finalMessageObserved = true;
      }
      const itemType = event.item?.type;
      if (
        event.type === 'item.completed' &&
        typeof itemType === 'string' &&
        ['command_execution', 'file_change', 'mcp_tool_call'].includes(itemType)
      ) {
        const key = `${itemType}:${event.item.status ?? 'unknown'}`;
        toolStates[key] = (toolStates[key] ?? 0) + 1;
      }
    } else if (client === 'opencode') {
      if (event.type === 'text') {
        finalMessageObserved = true;
      }
      if (event.type === 'tool_use') {
        const key = `${event.part?.tool ?? 'unknown'}:${event.part?.state?.status ?? 'unknown'}`;
        toolStates[key] = (toolStates[key] ?? 0) + 1;
        if (event.part?.tool === 'write') {
          const target = event.part?.state?.input?.filePath ?? event.part?.state?.input?.path;
          if (typeof target !== 'string' || !workspace) {
            writeTargets.unknown += 1;
          } else {
            const base = path.resolve(workspace);
            const resolved = path.resolve(workspace, target);
            const normalizedBase = process.platform === 'win32' ? base.toLowerCase() : base;
            const normalizedTarget =
              process.platform === 'win32' ? resolved.toLowerCase() : resolved;
            if (
              normalizedTarget === normalizedBase ||
              normalizedTarget.startsWith(`${normalizedBase}${path.sep}`)
            ) {
              writeTargets.inWorkspace += 1;
            } else {
              writeTargets.outsideWorkspace += 1;
            }
          }
        }
      }
    }
  }

  return {
    eventTypes,
    toolStates,
    clientErrorEvents,
    clientReportedError,
    finalMessageObserved,
    writeTargets,
    errorClasses,
  };
}

export function summarizeRequests(details) {
  const requests = details.map((detail) => {
    const request = detail.request;
    const requestBody = detail.bodies.find(
      (body) => body.ownerKind === 'parent' && body.direction === 'request',
    );
    const responseBody = detail.bodies.find(
      (body) => body.ownerKind === 'parent' && body.direction === 'response',
    );
    let route = request.url;
    try {
      const parsed = new URL(request.url, 'http://127.0.0.1');
      route = parsed.pathname;
    } catch {
      // The audit path remains useful when it is not a valid URL.
    }
    return {
      timestamp: request.timestamp,
      route,
      protocol: request.protocol,
      status: request.status,
      outcome: request.outcome,
      durationMs: request.durationMs,
      mappedModel: request.mappedModel,
      physicalModel: request.physicalModel,
      clientIp: request.clientIp,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      reasoningTokens: request.reasoningTokens,
      hasTextOutput: request.hasTextOutput,
      responsePartial: request.responsePartial,
      requestBytes: requestBody?.logicalBytes ?? null,
      responseBytes: responseBody?.logicalBytes ?? null,
      responseState: responseBody?.state ?? null,
      attemptStatuses: detail.attempts.map((attempt) => attempt.status),
    };
  });
  const total = (field) => requests.reduce((sum, request) => sum + (request[field] ?? 0), 0);
  const usageReported =
    requests.length > 0 &&
    requests.every(
      (request) => Number.isInteger(request.inputTokens) && Number.isInteger(request.outputTokens),
    );
  return {
    requests,
    count: requests.length,
    successfulCount: requests.filter((request) => request.status >= 200 && request.status < 300)
      .length,
    failedCount: requests.filter((request) => request.status === null || request.status >= 400)
      .length,
    upstream429Attempts: requests.reduce(
      (sum, request) => sum + request.attemptStatuses.filter((status) => status === 429).length,
      0,
    ),
    usageReported,
    inputTokens: usageReported ? total('inputTokens') : null,
    outputTokens: usageReported ? total('outputTokens') : null,
    reasoningTokens: requests.some((request) => request.reasoningTokens !== null)
      ? total('reasoningTokens')
      : null,
  };
}

export function evaluateRun({
  exitCode,
  timedOut,
  artifactBytes,
  events,
  audit,
  thoughtWriteFailuresDelta,
  budgets,
}) {
  const failures = [];
  if (timedOut) failures.push('client-timeout');
  if (exitCode !== 0) failures.push('client-exit');
  if (events.clientReportedError || events.clientErrorEvents > 0)
    failures.push('client-error-event');
  if (!events.finalMessageObserved) failures.push('no-final-message');
  if (!Number.isInteger(artifactBytes) || artifactBytes <= 0) failures.push('artifact-missing');
  if (audit.count === 0) failures.push('no-gateway-request');
  if (audit.failedCount > 0) failures.push('gateway-request-failed');
  if (
    audit.requests.some((request) => request.clientIp !== '127.0.0.1' && request.clientIp !== '::1')
  )
    failures.push('non-loopback-client');
  if (
    audit.requests.some(
      (request) =>
        request.responsePartial || (request.responseState && request.responseState !== 'complete'),
    )
  )
    failures.push('response-incomplete');
  if (thoughtWriteFailuresDelta > 0) failures.push('thought-store-write-failed');
  if (budgets.input !== null && audit.inputTokens !== null && audit.inputTokens > budgets.input)
    failures.push('input-token-budget');
  if (budgets.output !== null && audit.outputTokens !== null && audit.outputTokens > budgets.output)
    failures.push('output-token-budget');
  return { passed: failures.length === 0, failures };
}
