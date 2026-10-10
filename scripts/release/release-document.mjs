import { z } from 'zod';
import { HashSchema, TagSchema } from './release-source.mjs';

const ReferenceSchema = z.string().regex(/^(?:commit:[a-f0-9]{40}|pr:[1-9]\d*)$/);
const ItemSchema = z.strictObject({
  title: z.string().trim().min(1),
  text: z.string().trim().min(1),
  references: z.array(ReferenceSchema).min(1),
});
export const areas = {
  core: '🏗️ Accounts & Core',
  gateway: '🌐 Proxy Gateway & Models',
  desktop: '🖥️ Desktop & User Experience',
  integrations: '📱 Platforms & Integrations',
  tooling: '🔧 Tooling & Maintenance',
  security: '🔒 Security & Reliability',
  documentation: '📚 Documentation',
};
export const DocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
    source: z.strictObject({ baseTag: TagSchema.nullable(), headSha: HashSchema }),
    overview: z.string().trim().min(1),
    highlights: z.array(ItemSchema).min(1).max(12),
    sections: z
      .array(
        z.strictObject({ area: z.enum(Object.keys(areas)), items: z.array(ItemSchema).min(1) }),
      )
      .min(1),
    upgradeNotes: z.array(z.string().trim().min(1)),
  })
  .refine(
    (document) =>
      new Set(document.sections.map((section) => section.area)).size === document.sections.length,
    'Domain sections must be unique.',
  );

function escapeText(text) {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]<>#]/g, '\\$&');
}

function validateReferences(document, data) {
  const commits = new Map(data.commits.map((commit) => [commit.hash, commit]));
  const pulls = new Map(data.pullRequests.map((pull) => [pull.number, pull]));
  const covered = new Set();
  const validate = (item, details) => {
    for (const reference of item.references) {
      const [kind, id] = reference.split(':');
      if ((kind === 'commit' && !commits.has(id)) || (kind === 'pr' && !pulls.has(Number(id)))) {
        throw new Error('Release document cites a change outside the verified release range.');
      }
      if (details) {
        covered.add(reference);
      }
    }
  };
  document.highlights.forEach((item) => validate(item, false));
  document.sections.forEach((section) => section.items.forEach((item) => validate(item, true)));
  for (const commit of data.commits) {
    if (
      !covered.has(`commit:${commit.hash}`) &&
      !commit.pullNumbers.some((number) => covered.has(`pr:${number}`))
    ) {
      throw new Error('Release document omits a source change from its domain sections.');
    }
  }
  for (const pull of data.pullRequests) {
    if (
      !covered.has(`pr:${pull.number}`) &&
      !data.commits.some(
        (commit) =>
          commit.pullNumbers.includes(pull.number) && covered.has(`commit:${commit.hash}`),
      )
    ) {
      throw new Error('Release document omits a merged PR from its domain sections.');
    }
  }
}

function contributors(data) {
  const result = new Map();
  for (const commit of data.commits) {
    if (!commit.bot && commit.login) {
      const name = `@${commit.login}`;
      result.set(name, { name, prs: 0 });
    }
  }
  for (const pull of data.pullRequests.filter((pull) => !pull.bot)) {
    const name = `@${pull.login}`;
    const person = result.get(name) || { name, prs: 0 };
    person.prs += 1;
    result.set(name, person);
  }
  return [...result.values()].sort((a, b) => b.prs - a.prs || a.name.localeCompare(b.name));
}

export function renderReleaseDocument(
  document,
  data,
  date = new Date().toISOString().slice(0, 10),
) {
  validateReferences(document, data);
  const people = contributors(data);
  const repositoryUrl = `https://github.com/${data.repository}`;
  const referencesWithPulls = (references) =>
    references.flatMap((reference) => {
      const [kind, id] = reference.split(':');
      const pulls =
        kind === 'commit' ? data.commits.find((commit) => commit.hash === id).pullNumbers : [];
      return pulls.length ? pulls.map((number) => `pr:${number}`) : [reference];
    });
  const referenceLinks = (references) =>
    [...new Set(referencesWithPulls(references))]
      .map((reference) => {
        const [kind, id] = reference.split(':');
        return kind === 'pr'
          ? `[#${id}](${repositoryUrl}/pull/${id})`
          : `[${id.slice(0, 7)}](${repositoryUrl}/commit/${id})`;
      })
      .join(', ');
  const item = (entry) =>
    `- **${escapeText(entry.title)}** — ${escapeText(entry.text)} (${referenceLinks(entry.references)})`;
  const count = (amount, label) => `${amount} ${label}${amount === 1 ? '' : 's'}`;
  const lines = [
    `# 🚀 Antigravity Manager Release v${document.version}`,
    '',
    `**Release Date:** ${date}`,
    `**${data.baseTag ? `Since ${data.baseTag}` : 'First release'}:** ${count(data.commits.length, 'commit')} · ${count(data.pullRequests.length, 'merged PR')} · ${count(people.length, 'verified contributor')}`,
    '',
    `> ${escapeText(document.overview)}`,
    '',
    '---',
    '',
    '## ✨ Highlights',
    '',
    ...document.highlights.map(item),
  ];
  for (const section of document.sections) {
    lines.push('', '---', '', `## ${areas[section.area]}`, '', ...section.items.map(item));
  }
  if (document.upgradeNotes.length) {
    lines.push(
      '',
      '---',
      '',
      '## ⚙️ Upgrade Notes',
      '',
      ...document.upgradeNotes.map((note) => `- ${escapeText(note)}`),
    );
  }
  lines.push(
    '',
    '---',
    '',
    '## 👥 Contributors',
    '',
    'Thanks to everyone who contributed to this release.',
    '',
    people.map((person) => person.name).join(' · '),
  );
  const unmapped = [
    ...new Set(
      data.commits
        .filter((commit) => !commit.bot && !commit.login)
        .map((commit) => commit.authorName),
    ),
  ];
  if (unmapped.length) {
    lines.push(
      '',
      `Git authors without verified GitHub attribution: ${unmapped.map(escapeText).join(' · ')}.`,
    );
  }
  const bots = [
    ...new Set([
      ...data.pullRequests.filter((pull) => pull.bot).map((pull) => `@${pull.login}`),
      ...data.commits
        .filter((commit) => commit.bot)
        .map((commit) => (commit.login ? `@${commit.login}` : commit.authorName)),
    ]),
  ];
  if (bots.length) {
    lines.push('', `Maintenance: ${bots.join(' · ')}.`);
  }
  if (data.pullRequests.length) {
    lines.push(
      '',
      '<details>',
      '<summary>Merged pull requests and authors</summary>',
      '',
      ...data.pullRequests.map(
        (pull) =>
          `- ${escapeText(pull.title)} by @${pull.login} ([#${pull.number}](${repositoryUrl}/pull/${pull.number}))`,
      ),
      '',
      '</details>',
    );
  }
  const comparison = data.baseTag
    ? `${repositoryUrl}/compare/${data.baseTag}...v${document.version}`
    : `${repositoryUrl}/commits/v${document.version}`;
  lines.push('', '---', '', `**Full Changelog:** ${comparison}`);
  if (data.commits.some((commit) => !commit.resolved)) {
    lines.push(
      '',
      '_Local preview: some commits are not on GitHub yet; PR attribution is incomplete._',
    );
  }
  return lines.join('\n');
}
