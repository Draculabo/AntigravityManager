import { beforeEach, describe, expect, it, vi } from 'vitest';

const jsonSchemaMocks = vi.hoisted(() => ({
  normalizeObjectJsonSchema: vi.fn(),
}));

vi.mock('@/modules/proxy-gateway/antigravity/JsonSchemaUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/proxy-gateway/antigravity/JsonSchemaUtils')>();
  jsonSchemaMocks.normalizeObjectJsonSchema.mockImplementation(actual.normalizeObjectJsonSchema);
  return {
    ...actual,
    normalizeObjectJsonSchema: jsonSchemaMocks.normalizeObjectJsonSchema,
  };
});

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

function createRequest(overrides: Partial<ClaudeRequest> = {}): ClaudeRequest {
  return {
    model: 'gemini-3-flash',
    messages: [{ role: 'user', content: 'Help me fix the issue.' }],
    ...overrides,
  };
}

describe('ClaudeRequestMapper cache compatibility', () => {
  beforeEach(() => {
    jsonSchemaMocks.normalizeObjectJsonSchema.mockClear();
  });

  it('extracts embedded system messages into systemInstruction without mutating the request', () => {
    const request = createRequest({
      system: 'Top-level system prompt.',
      messages: [
        { role: 'system', content: 'Embedded string prompt.' },
        { role: 'user', content: 'Help me fix the issue.' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Embedded block prompt.' },
            { type: 'text', text: '' },
          ],
        },
      ],
    });

    const body = transformClaudeRequestIn(request, 'project-a', 'test-agent');

    expect(body.request.contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Help me fix the issue.' }],
      },
    ]);
    expect(body.request.systemInstruction?.parts).toHaveLength(1);
    expect(body.request.systemInstruction?.parts[0]?.text).toContain(
      '<identity>\nYou are Antigravity',
    );
    expect(body.request.systemInstruction?.parts[0]?.text).toContain(
      [
        '<customizations>',
        'Top-level system prompt.',
        '',
        'Embedded string prompt.',
        '',
        'Embedded block prompt.',
        '</customizations>',
      ].join('\n'),
    );
    expect(request.messages).toHaveLength(3);
    expect(request.messages[0]?.role).toBe('system');
  });

  it('preserves an explicit Codex identity without injecting Antigravity', () => {
    const body = transformClaudeRequestIn(
      createRequest({
        system: 'You are Codex, an agentic coding assistant.',
      }),
      'project-a',
      'test-agent',
    );
    const systemInstruction = body.request.systemInstruction?.parts
      .map((part) => part.text)
      .join('\n');

    expect(systemInstruction).toContain('You are Codex');
    expect(systemInstruction).not.toContain('You are Antigravity');
  });

  it('classifies Codex context blocks without rewriting their contents', () => {
    const body = transformClaudeRequestIn(
      createRequest({
        system: [
          'You are Codex, an agentic coding assistant.',
          '# Working with the user',
          'Keep status updates concise.',
          '<permissions instructions>',
          'Network access is enabled.',
          '</permissions instructions>',
          '<app-context>',
          'The user is running the desktop app.',
          '</app-context>',
          '<skills_instructions>',
          '- tdd: Use red-green-refactor.',
          '</skills_instructions>',
          '<plugins_instructions>',
          'Preserve plugin trigger rules.',
          '</plugins_instructions>',
          '<collaboration_mode>',
          'Default mode is active.',
          '</collaboration_mode>',
          '## Memory',
          '- Keep the original requirements.',
        ].join('\n'),
      }),
      'project-a',
      'test-agent',
    );
    const systemInstruction = body.request.systemInstruction?.parts[0]?.text;

    expect(systemInstruction).toBe(
      [
        '<identity>',
        'You are Codex, an agentic coding assistant.',
        '</identity>',
        '<environment_permissions>',
        'Network access is enabled.',
        '</environment_permissions>',
        '<app_context>',
        'The user is running the desktop app.',
        '</app_context>',
        '<skills>',
        '- tdd: Use red-green-refactor.',
        '</skills>',
        '<plugins>',
        'Preserve plugin trigger rules.',
        '</plugins>',
        '<memory>',
        '## Memory',
        '- Keep the original requirements.',
        '</memory>',
        '<planning_mode>',
        'Default mode is active.',
        '</planning_mode>',
        '<communication_style>',
        '# Working with the user',
        'Keep status updates concise.',
        '</communication_style>',
      ].join('\n'),
    );
  });

  it('explains how to read Skill files when shell_command is available', () => {
    const body = transformClaudeRequestIn(
      createRequest({
        system: [
          'You are Codex, an agentic coding assistant.',
          '<skills_instructions>',
          '- tdd: Read C:\\skills\\tdd\\SKILL.md before use.',
          '</skills_instructions>',
        ].join('\n'),
        tools: [
          {
            name: 'shell_command',
            description: 'Run a shell command.',
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
            },
          },
        ],
      }),
      'project-a',
      'test-agent',
    );
    const systemInstruction = body.request.systemInstruction?.parts[0]?.text;

    expect(systemInstruction).toContain('[CRITICAL INSTRUCTION FOR GEMINI - HOW TO READ SKILL.md]');
    expect(systemInstruction).toContain('Get-Content -Raw -LiteralPath');
    expect(systemInstruction).toContain('shell_command');
  });

  it('does not inject Skill-reading instructions when no Skill block is present', () => {
    const body = transformClaudeRequestIn(
      createRequest({
        system: 'You are Codex, an agentic coding assistant.',
        tools: [
          {
            name: 'shell_command',
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
            },
          },
        ],
      }),
      'project-a',
      'test-agent',
    );
    const systemInstruction = body.request.systemInstruction?.parts[0]?.text;

    expect(systemInstruction).not.toContain(
      '[CRITICAL INSTRUCTION FOR GEMINI - HOW TO READ SKILL.md]',
    );
  });

  it('places stable request fields before contents and keeps requestId last', () => {
    const body = transformClaudeRequestIn(
      createRequest({
        system: 'Stable system prompt.',
        max_tokens: 1024,
        metadata: { user_id: 'session-a' },
        tools: [
          {
            name: 'read_file',
            description: 'Read a file.',
            input_schema: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
            },
          },
        ],
      }),
      'project-a',
      'test-agent',
    );

    expect(Object.keys(body.request)).toEqual([
      'systemInstruction',
      'tools',
      'toolConfig',
      'tool_config',
      'generationConfig',
      'safetySettings',
      'contents',
    ]);
    expect(Object.keys(body)).toEqual([
      'project',
      'request',
      'model',
      'userAgent',
      'requestType',
      'enabledCreditTypes',
      'requestId',
    ]);
  });

  it('sorts function declarations by name', () => {
    const body = transformClaudeRequestIn(
      createRequest({
        tools: [
          {
            name: 'zeta_tool',
            input_schema: { type: 'object', properties: {} },
          },
          {
            name: 'alpha_tool',
            input_schema: { type: 'object', properties: {} },
          },
        ],
      }),
      'project-a',
      'test-agent',
    );

    expect(
      body.request.tools?.[0]?.functionDeclarations?.map((declaration) => declaration.name),
    ).toEqual(['alpha_tool', 'zeta_tool']);
  });

  it('stabilizes dynamic system metadata for cross-request prefix caching', () => {
    const first = transformClaudeRequestIn(
      createRequest({
        system:
          'Current date: 2026-07-26\nSession req_a1b2c3d4\nTrace 123e4567-e89b-12d3-a456-426614174000\n\n\nRules stay stable.',
      }),
      'project-a',
      'test-agent',
    );
    const second = transformClaudeRequestIn(
      createRequest({
        system:
          'Current date: 2026-07-27\nSession req_ffeeddcc\nTrace aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n\n\nRules stay stable.',
      }),
      'project-a',
      'test-agent',
    );

    expect(first.request.systemInstruction).toEqual(second.request.systemInstruction);
    expect(first.request.systemInstruction?.parts[0]?.text).toContain(
      '<customizations>\nSession {id}\nTrace {uuid}\n\nRules stay stable.\n</customizations>',
    );
  });

  it('reuses locally cached tool declarations for identical tool schemas', () => {
    const request = createRequest({
      tools: [
        {
          name: 'cache_probe_tool',
          description: 'Verify the local tool schema cache.',
          input_schema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
          },
        },
      ],
    });

    transformClaudeRequestIn(request, 'project-a', 'test-agent');
    expect(jsonSchemaMocks.normalizeObjectJsonSchema).toHaveBeenCalledTimes(1);

    transformClaudeRequestIn(request, 'project-a', 'test-agent');
    expect(jsonSchemaMocks.normalizeObjectJsonSchema).toHaveBeenCalledTimes(1);
  });
});
