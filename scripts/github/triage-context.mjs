import {
  IssueSchema,
  LIMITS,
  MARKER,
  fingerprint,
  issueText,
  searchTerms,
  selectCandidates,
} from './triage-policy.mjs';

export async function prepareTriage(github, context, force = false) {
  const repo = context.repo;
  const issueNumber = Number(
    context.payload.issue?.number ?? context.payload.inputs?.['issue-number'],
  );
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error('A positive issue number is required.');
  }
  if (context.payload.comment) {
    const permission = await github.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username: context.actor,
    });
    if (!['write', 'maintain', 'admin'].includes(permission.data.permission)) {
      throw new Error('Only maintainers can request manual triage.');
    }
    force = true;
  }
  const { data } = await github.rest.issues.get({ ...repo, issue_number: issueNumber });
  const current = IssueSchema.parse(data);
  if (
    current.pull_request ||
    current.state !== 'open' ||
    current.labels.some((label) => label.name === 'skip-ai') ||
    data.user?.type === 'Bot'
  ) {
    return null;
  }
  const hash = fingerprint(current);
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  if (
    !force &&
    comments.some(
      (comment) =>
        comment.user?.login === 'github-actions[bot]' &&
        comment.body?.includes(MARKER) &&
        comment.body.includes(`<!-- content:${hash} -->`),
    )
  ) {
    return null;
  }
  const searches = [];
  for (const term of searchTerms(current.title)) {
    const response = await github.rest.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:issue in:title "${term}"`,
      per_page: 5,
      sort: 'updated',
      order: 'desc',
    });
    searches.push(...response.data.items);
  }
  const recentResponse = await github.rest.issues.listForRepo({
    ...repo,
    state: 'all',
    sort: 'created',
    direction: 'desc',
    per_page: 20,
  });
  const recent = recentResponse.data
    .filter((issue) => !issue.pull_request && issue.number !== current.number)
    .slice(0, LIMITS.recent);
  return {
    issueNumber,
    fingerprint: hash,
    issue: issueText(current, LIMITS.body),
    candidates: selectCandidates(current, searches, recent),
  };
}
