import { z } from 'zod';
import { HashSchema, TagSchema } from './release-source.mjs';

const UserSchema = z.object({ login: z.string().min(1), type: z.string() });
const CommitResponseSchema = z.object({ sha: HashSchema, author: UserSchema.nullable() });
const PullResponseSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1),
  merged_at: z.string().nullable(),
  user: UserSchema,
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});
export const ReleaseDataSchema = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  baseTag: TagSchema.nullable(),
  headSha: HashSchema,
  commits: z.array(
    z.strictObject({
      hash: HashSchema,
      subject: z.string(),
      authorName: z.string(),
      login: z.string().nullable(),
      bot: z.boolean(),
      resolved: z.boolean(),
      pullNumbers: z.array(z.number().int().positive()),
    }),
  ),
  pullRequests: z.array(
    z.strictObject({
      number: z.number().int().positive(),
      title: z.string(),
      login: z.string(),
      bot: z.boolean(),
    }),
  ),
});

export function repositoryName(value) {
  try {
    const url = new URL(
      value.replace(/^git\+/, '').replace(/^git@github\.com:/, 'ssh://git@github.com/'),
    );
    const name = url.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    if (
      url.hostname === 'github.com' &&
      ['https:', 'ssh:'].includes(url.protocol) &&
      !url.search &&
      !url.hash &&
      /^[\w.-]+\/[\w.-]+$/.test(name)
    ) {
      return name;
    }
  } catch {
    // Fail without reflecting Git transport credentials into errors.
  }
  throw new Error('Release notes require a GitHub repository URL.');
}

async function githubJson(route, env, missingCommitHash) {
  let response;
  try {
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    response = await fetch(`https://api.github.com${route}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': 'AntigravityManager-release-notes',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (missingCommitHash && response.status === 404) {
      return null;
    }
  } catch {
    throw new Error('GitHub release metadata request failed or timed out.');
  }
  if (missingCommitHash && response.status === 422) {
    const body = await response.json().catch(() => null);
    if (
      z
        .object({ message: z.literal(`No commit found for SHA: ${missingCommitHash}`) })
        .safeParse(body).success
    ) {
      return null;
    }
  }
  if (!response.ok) {
    throw new Error(`GitHub release metadata request failed (HTTP ${response.status}).`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('GitHub release metadata returned invalid JSON.');
  }
}

export function isBot(login, type) {
  return type === 'Bot' || /\[bot\]$/i.test(login) || login === 'semantic-release-bot';
}

export async function collectReleaseData({
  repository,
  baseTag,
  headSha,
  commits,
  branch,
  env,
  allowLocal = false,
}) {
  const result = { repository, baseTag, headSha, commits: [], pullRequests: [] };
  const pulls = new Map();
  for (const commit of commits) {
    const raw = await githubJson(
      `/repos/${repository}/commits/${commit.hash}`,
      env,
      allowLocal ? commit.hash : undefined,
    );
    if (raw === null) {
      result.commits.push({
        ...commit,
        login: null,
        bot: isBot(commit.authorName),
        resolved: false,
        pullNumbers: [],
      });
      continue;
    }
    const parsed = CommitResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.sha !== commit.hash) {
      throw new Error('GitHub release metadata returned an invalid commit.');
    }
    const pullNumbers = [];
    for (let page = 1; ; page += 1) {
      const rawPulls = await githubJson(
        `/repos/${repository}/commits/${commit.hash}/pulls?per_page=100&page=${page}`,
        env,
      );
      const parsedPulls = z.array(PullResponseSchema).safeParse(rawPulls);
      if (!parsedPulls.success) {
        throw new Error('GitHub release metadata returned invalid pull requests.');
      }
      for (const pull of parsedPulls.data) {
        if (
          pull.merged_at &&
          pull.base.ref === branch &&
          pull.base.repo.full_name.toLowerCase() === repository.toLowerCase()
        ) {
          pullNumbers.push(pull.number);
          pulls.set(pull.number, {
            number: pull.number,
            title: pull.title,
            login: pull.user.login,
            bot: isBot(pull.user.login, pull.user.type),
          });
        }
      }
      if (parsedPulls.data.length < 100) {
        break;
      }
      if (page === 20) {
        throw new Error('GitHub PR attribution exceeded its pagination limit.');
      }
    }
    const author = parsed.data.author;
    result.commits.push({
      ...commit,
      login: author?.login ?? null,
      bot: author ? isBot(author.login, author.type) : isBot(commit.authorName),
      resolved: true,
      pullNumbers: [...new Set(pullNumbers)],
    });
  }
  result.pullRequests = [...pulls.values()].sort((a, b) => a.number - b.number);
  return ReleaseDataSchema.parse(result);
}
