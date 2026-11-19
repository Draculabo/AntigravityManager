import { expect, it } from 'vitest';
import { clientConfigDocument } from '@/modules/proxy-gateway/agent-tools/client-config-document';
import { planClientConfig } from '@/modules/proxy-gateway/agent-tools/client-config-plan';

it.each([
  { allow: undefined, after: undefined },
  { allow: [], after: [] },
  { allow: ['personal/model'], after: ['personal/model', 'antigravity-manager/*'] },
])('preserves the meaning of the existing OpenClaw allow list ($allow)', ({ allow, after }) => {
  const document = clientConfigDocument(
    'openclaw',
    JSON.stringify({
      agents: { defaults: { modelPolicy: { allow }, model: { primary: 'personal/model' } } },
    }),
  );
  planClientConfig(
    {
      client: 'openclaw',
      action: 'sync',
      version: 'v2',
      modelsMode: 'preserve',
      baseUrl: 'http://127.0.0.1:8045',
      models: ['gemini-3-flash'],
      activateModel: 'gemini-3-flash',
    },
    document,
    {
      client: 'openclaw',
      version: 1,
      fields: [],
      allowAdded: false,
      allowWasAbsent: false,
      createdMaps: [],
    },
    'openclaw.json',
    'a'.repeat(64),
    'fixture-key',
  );
  expect(document.get(['agents', 'defaults', 'modelPolicy', 'allow'])).toEqual(after);
  expect(document.get(['agents', 'defaults', 'model', 'primary'])).toBe(
    'antigravity-manager/gemini-3-flash',
  );
});
