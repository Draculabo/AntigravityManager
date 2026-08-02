import { describe, expect, it } from 'vitest';

import {
  flattenOpenAITools,
  splitNamespaceToolName,
} from '../../modules/proxy-gateway/antigravity/ToolNamespace';

describe('Responses tool namespaces', () => {
  it('recursively flattens namespace tools while preserving MCP names', () => {
    expect(
      flattenOpenAITools([
        {
          type: 'namespace',
          name: 'repo',
          tools: [
            {
              type: 'function',
              function: { name: 'read_file', parameters: { type: 'object' } },
            },
            {
              type: 'function',
              function: { name: 'mcp__github__search' },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        type: 'function',
        function: { name: 'repo__read_file', parameters: { type: 'object' } },
      },
      {
        type: 'function',
        function: { name: 'mcp__github__search' },
      },
    ]);
  });

  it('restores the namespace on output without splitting MCP tool names', () => {
    expect(splitNamespaceToolName('repo__read_file')).toEqual({
      name: 'read_file',
      namespace: 'repo',
    });
    expect(splitNamespaceToolName('mcp__github__search')).toEqual({
      name: 'mcp__github__search',
    });
  });
});
