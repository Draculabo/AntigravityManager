import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export function createLiveToolChecks({ http, probePath, marker, result }) {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  async function openAI(model, degraded = false) {
    const inputSchema = degraded
      ? { ...schema, properties: { ...schema.properties, optional: { $ref: '#/$defs/missing' } } }
      : schema;
    const tool = {
      type: 'function',
      function: {
        name: 'probe_read',
        description: 'Read the single controlled acceptance file.',
        parameters: inputSchema,
      },
    };
    const messages = [
      {
        role: 'user',
        content: `Use probe_read to read ${probePath}. After receiving the result, output only its exact content.`,
      },
    ];
    const first = z
      .object({
        choices: z.array(
          z.object({
            message: z
              .object({
                role: z.literal('assistant'),
                content: z.string().nullable().optional(),
                tool_calls: z
                  .array(
                    z.object({
                      id: z.string(),
                      type: z.literal('function'),
                      function: z.object({ name: z.string(), arguments: z.string() }),
                    }),
                  )
                  .optional(),
              })
              .passthrough(),
          }),
        ),
      })
      .parse(
        await http(
          '/v1/chat/completions',
          {
            model,
            messages,
            tools: [tool],
            tool_choice: { type: 'function', function: { name: 'probe_read' } },
            stream: false,
            max_tokens: 512,
          },
          `openai-${degraded ? 'degraded' : 'normal'}-call`,
        ),
      );
    const message = first.choices[0]?.message;
    if (!message?.tool_calls?.length) {
      throw new Error('Upstream did not return an OpenAI tool call');
    }
    const outputs = [];
    for (const call of message.tool_calls) {
      const args = z.object({ path: z.string() }).parse(JSON.parse(call.function.arguments));
      if (call.function.name !== 'probe_read' || path.resolve(args.path) !== probePath) {
        throw new Error('Tool call escaped the controlled file');
      }
      outputs.push({
        role: 'tool',
        tool_call_id: call.id,
        content: fs.readFileSync(probePath, 'utf8'),
      });
    }
    const final = z
      .object({
        choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })),
      })
      .parse(
        await http(
          '/v1/chat/completions',
          {
            model,
            messages: [...messages, message, ...outputs],
            tools: [tool],
            tool_choice: 'none',
            stream: false,
            max_tokens: 512,
          },
          `openai-${degraded ? 'degraded' : 'normal'}-result`,
        ),
      );
    if (!final.choices[0]?.message.content?.includes(marker)) {
      throw new Error('OpenAI tool result did not reach the final answer');
    }
    result.calls.at(-1).toolResultMatched = true;
  }

  async function gemini(model, label) {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'probe_read',
            description: 'Read the single controlled acceptance file.',
            parameters: schema,
          },
        ],
      },
    ];
    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: `Call probe_read to read ${probePath}. After receiving its functionResponse, output only the exact file content.`,
          },
        ],
      },
    ];
    const first = z
      .object({
        candidates: z.array(
          z.object({
            content: z
              .object({
                role: z.string(),
                parts: z.array(
                  z
                    .object({
                      functionCall: z
                        .object({ name: z.string(), args: z.unknown(), id: z.string().optional() })
                        .optional(),
                    })
                    .passthrough(),
                ),
              })
              .passthrough(),
          }),
        ),
      })
      .parse(
        await http(
          `/v1beta/models/${model}:generateContent`,
          {
            contents,
            tools,
            toolConfig: {
              functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['probe_read'] },
            },
            generationConfig: { maxOutputTokens: 512 },
          },
          `${label}-call`,
        ),
      );
    const modelContent = first.candidates[0]?.content;
    const calls =
      modelContent?.parts.flatMap((part) => (part.functionCall ? [part.functionCall] : [])) ?? [];
    if (calls.length === 0) {
      throw new Error('Upstream did not return a Gemini tool call');
    }
    const responses = calls.map((call) => {
      const args = z.object({ path: z.string() }).parse(call.args);
      if (call.name !== 'probe_read' || path.resolve(args.path) !== probePath) {
        throw new Error('Tool call escaped the controlled file');
      }
      return {
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: { content: fs.readFileSync(probePath, 'utf8') },
        },
      };
    });
    const final = z
      .object({
        candidates: z.array(
          z.object({
            content: z.object({
              parts: z.array(z.object({ text: z.string().optional() }).passthrough()),
            }),
          }),
        ),
      })
      .parse(
        await http(
          `/v1beta/models/${model}:generateContent`,
          {
            contents: [...contents, modelContent, { role: 'user', parts: responses }],
            tools,
            toolConfig: { functionCallingConfig: { mode: 'NONE' } },
            generationConfig: { maxOutputTokens: 512 },
          },
          `${label}-result`,
        ),
      );
    if (!final.candidates[0]?.content.parts.some((part) => part.text?.includes(marker))) {
      throw new Error('Gemini tool result did not reach the final answer');
    }
    result.calls.at(-1).toolResultMatched = true;
  }

  return { openAI, gemini };
}
