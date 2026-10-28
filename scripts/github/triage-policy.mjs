import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MODEL = 'deepseek-v4-1-flash-260910';
export const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const MARKER = '<!-- agm-issue-triage:v1 -->';
export const TYPES = ['bug', 'enhancement', 'documentation', 'question'];
export const AREAS = ['cloud-account', 'proxy-gateway', 'antigravity-runtime', 'app-shell'];
export const LIMITS = Object.freeze({ recent: 5, candidates: 3, body: 5000, candidateBody: 500 });

const IssueFields = {
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.object({ name: z.string() })),
};
export const IssueSchema = z.object({ ...IssueFields, pull_request: z.unknown().optional() });
export const ClassificationSchema = z.strictObject({
  category: z.enum(TYPES),
  areas: z.array(z.enum(AREAS)).max(2),
});
export const DuplicatesSchema = z.strictObject({
  duplicates: z
    .array(
      z.strictObject({
        issueNumber: z.number().int().positive(),
        reason: z.string().trim().min(1).max(300),
      }),
    )
    .max(3),
});
export const ResultSchema = z.strictObject({
  issueNumber: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  classification: ClassificationSchema,
  duplicates: DuplicatesSchema.shape.duplicates,
});

/** Content changes invalidate in-flight results, including edits past the clipping limit. */
export function fingerprint(issue) {
  return createHash('sha256')
    .update(JSON.stringify([issue.title, issue.body ?? '']))
    .digest('hex');
}

export function clip(text, limit) {
  return Array.from(text ?? '')
    .slice(0, limit)
    .join('');
}

export function issueText(issue, limit) {
  return { number: issue.number, title: clip(issue.title, 256), body: clip(issue.body, limit) };
}

/** Unicode letters preserve Chinese titles; API query syntax is never copied from the title. */
export function searchTerms(title) {
  return (title.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [])
    .filter((term) => Array.from(term).length >= 2)
    .slice(0, 3)
    .map((term) => clip(term, 32));
}

export function selectCandidates(current, searches, recent) {
  const candidates = new Map();
  for (const item of [...searches, ...recent.slice(0, LIMITS.recent)]) {
    const issue = IssueSchema.parse(item);
    if (issue.number !== current.number && !issue.pull_request && !candidates.has(issue.number)) {
      candidates.set(issue.number, issueText(issue, LIMITS.candidateBody));
    }
  }
  return [...candidates.values()].slice(0, LIMITS.candidates);
}

export function validateDuplicates(value, candidates) {
  const parsed = DuplicatesSchema.parse(value);
  const allowed = new Set(candidates.map((item) => item.number));
  const seen = new Set();
  for (const item of parsed.duplicates) {
    if (!allowed.has(item.issueNumber) || seen.has(item.issueNumber)) {
      throw new Error('Duplicate results must reference distinct supplied candidates.');
    }
    seen.add(item.issueNumber);
  }
  return parsed.duplicates;
}

export function labelsFor(classification, existing) {
  return [
    ...(existing.some((label) => TYPES.includes(label)) ? [] : [classification.category]),
    ...classification.areas.map((area) => `area:${area}`),
  ].filter((label) => !existing.includes(label));
}

function plainReason(reason) {
  return reason
    .replace(/[\r\n]+/g, ' ')
    .replace(/[@<>`#*_\\]/g, '')
    .replaceAll('[', '')
    .replaceAll(']', '');
}

export function resultComment(result) {
  const matches = result.duplicates.length
    ? [
        'Potential duplicate issues (please verify before closing):',
        '',
        ...result.duplicates.map((item) => `- #${item.issueNumber}: ${plainReason(item.reason)}`),
      ]
    : [
        'No likely duplicates were found among the supplied candidates. This is not an exhaustive search.',
      ];
  return [
    MARKER,
    `<!-- content:${result.fingerprint} -->`,
    '### Issue triage',
    '',
    `Suggested type: ${result.classification.category}.`,
    '',
    ...matches,
    '',
    'Automated suggestions; maintainers make the final decision.',
  ].join('\n');
}
