import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Compare one real parallel tool turn with its lossless adjacent-message representation. */
export async function verifyLiveToolHistory({
  http,
  workspace,
  model,
  result,
  extended = false,
  recovery = false,
}) {
  const files = ['left', 'right'].map((side) => {
    const file = path.join(workspace, `${side}.txt`);
    const marker = `history-${side}-${randomUUID()}`;
    fs.writeFileSync(file, marker, { mode: 0o600 });
    return { file, marker };
  });
  const tools = [
    {
      name: 'probe_read',
      description: 'Read one controlled acceptance file.',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path'],
      },
    },
  ];
  const user = {
    role: 'user',
    content: `Call probe_read for BOTH ${files[0].file} and ${files[1].file} in this turn, before receiving any results. After both results arrive, output both exact file contents.`,
  };
  const Block = z.object({ type: z.string() }).passthrough();
  const first = z.object({ content: z.array(Block) }).parse(
    await http(
      '/v1/messages',
      {
        model,
        max_tokens: 2048,
        messages: [user],
        tools,
        tool_choice: { type: 'tool', name: 'probe_read', disable_parallel_tool_use: false },
        stream: false,
      },
      'history-parallel-call',
    ),
  );
  const ToolUse = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.literal('probe_read'),
    input: z.object({ file_path: z.string() }),
  });
  const calls = first.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ToolUse.parse(block));
  const callFiles = calls.map((call) => path.resolve(call.input.file_path));
  result.toolHistory = {
    model,
    realParallelCalls: calls.length,
    distinctIds: new Set(calls.map((call) => call.id)).size === calls.length,
    controlledPathsMatched: files.every((file) => callFiles.includes(file.file)),
    splitAssistantMessages: 0,
    originalBlockOrderPreserved: false,
    signedBlocksObserved: first.content.filter(
      (block) => typeof block.signature === 'string' && block.signature.length > 0,
    ).length,
    combined: false,
    split: false,
    reversedResults: false,
    failures: [],
  };
  if (
    calls.length !== 2 ||
    new Set(calls.map((call) => call.id)).size !== 2 ||
    !files.every((file) => callFiles.includes(file.file))
  ) {
    throw new Error('Upstream did not return both controlled parallel reads');
  }
  const responses = {
    role: 'user',
    content: calls.map((call) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: fs.readFileSync(call.input.file_path, 'utf8'),
    })),
  };
  const split = [];
  let blocks = [];
  for (const block of first.content) {
    if (block.type === 'tool_use' && blocks.some((item) => item.type === 'tool_use')) {
      split.push({ role: 'assistant', content: blocks });
      blocks = [];
    }
    blocks.push(block);
  }
  split.push({ role: 'assistant', content: blocks });
  result.toolHistory.splitAssistantMessages = split.length;
  result.toolHistory.originalBlockOrderPreserved =
    JSON.stringify(split.flatMap((message) => message.content)) === JSON.stringify(first.content);
  const histories = [
    ['combined', [{ role: 'assistant', content: first.content }], responses, model],
    ['split', split, responses, model],
    ['reversedResults', split, { ...responses, content: [...responses.content].reverse() }, model],
  ];
  if (extended) {
    const continuationModel =
      model === 'gemini-3.1-pro-high' ? 'gemini-3.7-flash-high' : 'gemini-3.1-pro-high';
    result.toolHistory.continuationModel = continuationModel;
    result.toolHistory.resubmittedSameModel = false;
    result.toolHistory.crossModel = false;
    result.toolHistory.crossModelResubmitted = false;
    histories.push(
      ['resubmittedSameModel', split, responses, model],
      ['crossModel', split, responses, continuationModel],
      ['crossModelResubmitted', split, responses, continuationModel],
    );
  }
  if (recovery) {
    const corrupted = first.content.map((block) => {
      if (typeof block.signature !== 'string' || block.signature.length < 10) {
        return block;
      }
      const index = Math.floor(block.signature.length / 2);
      const character = block.signature[index] === 'A' ? 'B' : 'A';
      return {
        ...block,
        signature: `${block.signature.slice(0, index)}${character}${block.signature.slice(index + 1)}`,
      };
    });
    const omitSignatures = (blocks) => blocks.map(({ signature: _signature, ...block }) => block);
    result.toolHistory.signatureRecovery = {
      signatureChanged: JSON.stringify(corrupted) !== JSON.stringify(first.content),
      otherBlocksUnchanged:
        JSON.stringify(omitSignatures(corrupted)) === JSON.stringify(omitSignatures(first.content)),
      resultMatched: false,
      upstreamRetryVerified: false,
    };
    if (
      !result.toolHistory.signatureRecovery.signatureChanged ||
      !result.toolHistory.signatureRecovery.otherBlocksUnchanged
    ) {
      throw new Error('Controlled signature corruption could not preserve the tool history');
    }
    histories.push([
      'corruptedSignature',
      [{ role: 'assistant', content: corrupted }],
      responses,
      model,
    ]);
  }
  let splitRequest;
  let crossModelRequest;
  for (const [label, assistants, outputs, targetModel] of histories) {
    const body = {
      model: targetModel,
      max_tokens: 2048,
      messages: [user, ...assistants, outputs],
      tools,
      stream: false,
    };
    if (label === 'split') {
      splitRequest = JSON.stringify(body);
    } else if (label === 'crossModel') {
      crossModelRequest = JSON.stringify(body);
    } else if (label === 'resubmittedSameModel') {
      result.toolHistory.sameModelResubmissionIdentical = JSON.stringify(body) === splitRequest;
      if (!result.toolHistory.sameModelResubmissionIdentical) {
        throw new Error('Same-model history resubmission changed the request');
      }
    } else if (label === 'crossModelResubmitted') {
      result.toolHistory.crossModelResubmissionIdentical =
        JSON.stringify(body) === crossModelRequest;
      if (!result.toolHistory.crossModelResubmissionIdentical) {
        throw new Error('Cross-model history resubmission changed the request');
      }
    }
    try {
      const reply = z
        .object({ content: z.array(Block) })
        .parse(await http('/v1/messages', body, `history-${label}-result`));
      const text = reply.content
        .filter((block) => block.type === 'text')
        .map((block) => z.string().parse(block.text))
        .join('');
      const matched = files.every((file) => text.includes(file.marker));
      result.toolHistory[label] = matched;
      if (label === 'corruptedSignature') {
        result.toolHistory.signatureRecovery.resultMatched = matched;
      }
      if (!matched) {
        result.toolHistory.failures.push({ variant: label, reason: 'result-markers-missing' });
      }
    } catch {
      result.toolHistory.failures.push({ variant: label, reason: 'gateway-or-upstream-rejection' });
    }
  }
  if (result.toolHistory.failures.length > 0) {
    throw new Error('Tool history comparison failed; see bounded variant evidence');
  }
}
