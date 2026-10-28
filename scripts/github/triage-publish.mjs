import {
  IssueSchema,
  MARKER,
  ResultSchema,
  fingerprint,
  labelsFor,
  resultComment,
} from './triage-policy.mjs';

export async function publishTriage(github, repo, raw) {
  const result = ResultSchema.parse(raw);
  const params = { ...repo, issue_number: result.issueNumber };
  const current = IssueSchema.parse((await github.rest.issues.get(params)).data);
  if (
    current.pull_request ||
    current.state !== 'open' ||
    fingerprint(current) !== result.fingerprint ||
    current.labels.some((label) => label.name === 'skip-ai')
  ) {
    return 'outdated-or-excluded';
  }
  const labels = labelsFor(
    result.classification,
    current.labels.map((label) => label.name),
  );
  const available = await github.paginate(github.rest.issues.listLabelsForRepo, {
    ...repo,
    per_page: 100,
  });
  for (const label of labels) {
    if (!available.some((existing) => existing.name === label)) {
      // Creating only a deterministic allowlisted label also supports a fresh repository setup.
      try {
        await github.rest.issues.createLabel({
          ...repo,
          name: label,
          color: label.startsWith('area:') ? '1d76db' : 'ededed',
        });
      } catch (error) {
        if (
          error.status !== 422 ||
          !(await github.rest.issues.getLabel({ ...repo, name: label })).data
        ) {
          throw error;
        }
      }
    }
  }
  if (labels.length) {
    await github.rest.issues.addLabels({ ...params, labels });
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...params,
    per_page: 100,
  });
  const comment = comments.find(
    (item) => item.user?.login === 'github-actions[bot]' && item.body?.includes(MARKER),
  );
  const body = resultComment(result);
  if (comment) {
    await github.rest.issues.updateComment({ ...repo, comment_id: comment.id, body });
  } else {
    await github.rest.issues.createComment({ ...params, body });
  }
  return 'published';
}
