import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import OpenAI from 'openai';
import YAML from 'yaml';
import { prepareTriage } from './triage-context.mjs';
import { inferTriage } from './triage-infer.mjs';
import { publishTriage } from './triage-publish.mjs';
import {
  LIMITS,
  MODEL,
  MARKER,
  fingerprint,
  selectCandidates,
  searchTerms,
} from './triage-policy.mjs';
import { validateAutomation } from './workflow-contracts.mjs';

const repo = { owner: 'fixture', repo: 'repository' };
const issue = (number, body = 'A streaming error') => ({
  number,
  title: '代理网关 流式响应失败',
  body,
  state: 'open',
  labels: [],
  user: { type: 'User' },
});
const input = () => ({
  issueNumber: 10,
  fingerprint: fingerprint(issue(10)),
  issue: {
    number: 10,
    title: issue(10).title,
    body: issue(10).body,
  },
  candidates: [{ number: 2, title: 'Streaming error', body: 'Same error' }],
});
const classification = { category: 'bug', areas: ['proxy-gateway'] };
const result = () => ({
  issueNumber: 10,
  fingerprint: fingerprint(issue(10)),
  classification,
  duplicates: [{ issueNumber: 2, reason: 'Same error signature.' }],
});

function fixture(current = issue(10)) {
  const calls = [];
  const comments = [];
  const available = [{ name: 'bug' }, { name: 'area:proxy-gateway' }];
  const rest = {
    issues: {
      get: async () => ({ data: current }),
      listComments: () => {},
      listLabelsForRepo: () => {},
      listForRepo: async () => ({
        data: [current, ...Array.from({ length: 10 }, (_, i) => issue(i + 20))],
      }),
      addLabels: async (args) => {
        calls.push(['labels', args.labels]);
      },
      createLabel: async () => {
        throw new Error('Unexpected label creation');
      },
      createComment: async ({ body }) => {
        calls.push(['create-comment']);
        comments.push({ id: 1, user: { login: 'github-actions[bot]' }, body });
      },
      updateComment: async ({ body }) => {
        calls.push(['update-comment']);
        comments[0].body = body;
      },
    },
    search: { issuesAndPullRequests: async () => ({ data: { items: [issue(2)] } }) },
    repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }) },
  };
  return {
    calls,
    comments,
    current,
    github: {
      rest,
      paginate: async (method) => (method === rest.issues.listComments ? comments : available),
    },
  };
}

test('Chinese title retrieval and candidate clipping preserve Unicode and exclude PRs and self', () => {
  assert.deepEqual(searchTerms('代理网关 流式响应失败'), ['代理网关', '流式响应失败']);
  const candidates = selectCandidates(
    issue(10),
    [issue(10), { ...issue(1), pull_request: {} }, issue(2, '😀'.repeat(600)), issue(2)],
    Array.from({ length: 10 }, (_, i) => issue(i + 20)),
  );
  assert.deepEqual(
    candidates.map((item) => item.number),
    [2, 20, 21],
  );
  assert.equal(Array.from(candidates[0].body).length, 500);
  assert.equal(
    selectCandidates(
      issue(10),
      [],
      Array.from({ length: 10 }, (_, i) => issue(20 + i)),
    )[0].number,
    20,
  );
});

test('recent supplemental retrieval and prepared model input respect both clipping boundaries', async () => {
  const f = fixture(issue(10, '中'.repeat(6000)));
  f.github.rest.search.issuesAndPullRequests = async () => ({ data: { items: [] } });
  const prepared = await prepareTriage(f.github, { repo, payload: { issue: { number: 10 } } });
  assert.equal(prepared.issue.body.length, LIMITS.body);
  assert.deepEqual(
    prepared.candidates.map((item) => item.number),
    [20, 21, 22],
  );
  assert.equal(prepared.candidates.length, 3);
});

test('completed fingerprints suppress inference preparation, while edits and force allow a rerun', async () => {
  const f = fixture();
  f.comments.push({
    user: { login: 'github-actions[bot]' },
    body: `${MARKER}\n<!-- content:${fingerprint(f.current)} -->`,
  });
  const context = { repo, payload: { issue: { number: 10 } } };
  assert.equal(await prepareTriage(f.github, context), null);
  assert(await prepareTriage(f.github, context, true));
  f.current.body += ' New detail';
  assert(await prepareTriage(f.github, context));
});

test('untrusted users cannot manually invoke paid triage', async () => {
  const f = fixture();
  await assert.rejects(
    prepareTriage(f.github, {
      repo,
      actor: 'reader',
      payload: { issue: { number: 10 }, comment: { body: '/bot triage' } },
    }),
    /Only maintainers/,
  );
});

test('the real official SDK sends two bounded Chat Completions requests with thinking disabled', async () => {
  const requests = [];
  const replies = [classification, { duplicates: result().duplicates }];
  const client = new OpenAI({
    apiKey: 'synthetic-test-key',
    baseURL: 'https://fixture.invalid/api/v3',
    maxRetries: 0,
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://fixture.invalid/api/v3/chat/completions');
      requests.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(replies.shift()),
              },
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 20 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  assert.deepEqual(await inferTriage(input(), client), result());
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, MODEL);
    assert.deepEqual(request.thinking, { type: 'disabled' });
    assert.deepEqual(request.response_format, { type: 'json_object' });
    assert.equal(request.stream, false);
    assert.equal(request.max_tokens, 800);
    assert.equal(Object.hasOwn(request, 'tools'), false);
  }
});

test('unknown labels, truncated JSON, hallucinated duplicates and duplicate numbers fail without publishing', async () => {
  const client = (values) => ({
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify(values.shift()) },
            },
          ],
        }),
      },
    },
  });
  await assert.rejects(
    inferTriage(input(), client([{ category: 'delete-everything', areas: [] }])),
  );
  for (const duplicates of [
    [{ issueNumber: 999, reason: 'invented' }],
    [
      { issueNumber: 2, reason: 'a' },
      { issueNumber: 2, reason: 'b' },
    ],
  ]) {
    await assert.rejects(inferTriage(input(), client([classification, { duplicates }])));
  }
  await assert.rejects(
    inferTriage(input(), {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ finish_reason: 'length', message: { content: '{' } }],
          }),
        },
      },
    }),
    /incomplete/,
  );
});

test('no candidates means no duplicate model call', async () => {
  let count = 0;
  const client = {
    chat: {
      completions: {
        create: async () => {
          count += 1;
          return {
            choices: [
              { finish_reason: 'stop', message: { content: JSON.stringify(classification) } },
            ],
          };
        },
      },
    },
  };
  assert.deepEqual((await inferTriage({ ...input(), candidates: [] }, client)).duplicates, []);
  assert.equal(count, 1);
});

test('write-back preserves a human type and updates the same bot comment on retries', async () => {
  const f = fixture({ ...issue(10), labels: [{ name: 'enhancement' }] });
  await publishTriage(f.github, repo, result());
  await publishTriage(f.github, repo, result());
  assert.deepEqual(f.calls, [
    ['labels', ['area:proxy-gateway']],
    ['create-comment'],
    ['labels', ['area:proxy-gateway']],
    ['update-comment'],
  ]);
  assert.equal(f.comments.length, 1);
});

test('edited, excluded, closed or PR targets cannot receive stale results', async () => {
  for (const current of [
    { ...issue(10), body: 'Edited' },
    { ...issue(10), state: 'closed' },
    { ...issue(10), labels: [{ name: 'skip-ai' }] },
    { ...issue(10), pull_request: {} },
  ]) {
    const f = fixture(current);
    assert.equal(await publishTriage(f.github, repo, result()), 'outdated-or-excluded');
    assert.deepEqual(f.calls, []);
  }
});

test('partial write failure can be retried without adding another comment', async () => {
  const f = fixture();
  const create = f.github.rest.issues.createComment;
  f.github.rest.issues.createComment = async (args) => {
    await create(args);
    throw new Error('Lost response');
  };
  await assert.rejects(publishTriage(f.github, repo, result()), /Lost response/);
  await publishTriage(f.github, repo, result());
  assert.equal(f.comments.length, 1);
  assert.equal(f.calls.at(-1)[0], 'update-comment');
});

function workflowFixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agm automation '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, '.github'), { recursive: true });
  cpSync('.github/workflows', path.join(cwd, '.github/workflows'), { recursive: true });
  return cwd;
}

test('workflow contracts reject a missing merge-gate dependency and privileged model write-back', (t) => {
  const cwd = workflowFixture(t);
  assert.deepEqual(validateAutomation(cwd), []);
  const file = path.join(cwd, '.github/workflows/pr-checks.yml');
  const pr = YAML.parse(readFileSync(file, 'utf8'));
  pr.jobs.required.needs.pop();
  writeFileSync(file, YAML.stringify(pr));
  assert(validateAutomation(cwd).some((error) => error.includes('aggregate every')));
  const aiFile = path.join(cwd, '.github/workflows/issue-triage.yml');
  const ai = YAML.parse(readFileSync(aiFile, 'utf8'));
  ai.jobs.apply.steps[0].env = { KEY: '${{ secrets.AI_API_KEY }}' };
  writeFileSync(aiFile, YAML.stringify(ai));
  assert(validateAutomation(cwd).some((error) => error.includes('cannot receive')));
});
