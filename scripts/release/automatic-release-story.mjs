import { areas, DocumentSchema } from './release-document.mjs';

const labels = {
  feat: 'Feature',
  fix: 'Fix',
  perf: 'Performance',
  docs: 'Documentation',
  refactor: 'Refactoring',
  build: 'Build',
  ci: 'CI',
  test: 'Tests',
  chore: 'Maintenance',
  style: 'Style',
};

function change(subject) {
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(subject);
  const type = match?.[1] || 'change';
  const description = (match?.[4] || subject).replace(/\s*\(#\d+\)$/, '').trim();
  return { type, scope: match?.[2] || '', breaking: Boolean(match?.[3]), description };
}

function areaFor(subject, scope) {
  if (/^docs(?:\(|:)/.test(subject)) {
    return 'documentation';
  }
  if (/security|credential|signatur|authentication/i.test(subject)) {
    return 'security';
  }
  if (/^(?:build|ci|release|test)$/.test(scope)) {
    return 'tooling';
  }
  if (/proxy|gateway|schema/i.test(subject)) {
    return 'gateway';
  }
  if (/cloud-account|account|oauth/i.test(subject)) {
    return 'core';
  }
  if (/app-shell|update|desktop|runtime/i.test(subject)) {
    return 'desktop';
  }
  return 'tooling';
}

function priority(entry) {
  if (entry.title === 'Breaking change') {
    return -1;
  }
  const index = ['feat', 'fix', 'perf'].indexOf(entry.type);
  return index === -1 ? 3 : index;
}

/** Build a factual story from source titles; never claim that generated text was reviewed. */
export function createAutomaticStory(version, data) {
  if (!data.commits.length) {
    throw new Error('Release notes require at least one source change.');
  }
  const groups = new Map();
  for (const commit of data.commits) {
    const key = commit.pullNumbers.length
      ? commit.pullNumbers
          .map((number) => `pr:${number}`)
          .sort()
          .join(',')
      : `commit:${commit.hash}`;
    const existing = groups.get(key);
    if (existing) {
      existing.references.push(`commit:${commit.hash}`);
      continue;
    }
    const pull = data.pullRequests.find((entry) => entry.number === commit.pullNumbers[0]);
    const parsed = change(pull?.title || commit.subject);
    const source = change(commit.subject);
    const type = labels[parsed.type] ? parsed.type : source.type;
    groups.set(key, {
      type,
      area: areaFor(commit.subject, source.scope),
      title: parsed.breaking || source.breaking ? 'Breaking change' : labels[type] || 'Change',
      text: parsed.description,
      references: [`commit:${commit.hash}`],
    });
  }
  const sections = new Map();
  for (const entry of groups.values()) {
    const items = sections.get(entry.area) || [];
    items.push({ title: entry.title, text: entry.text, references: entry.references });
    sections.set(entry.area, items);
  }
  const ranked = [...groups.values()].sort((a, b) => priority(a) - priority(b));
  return DocumentSchema.parse({
    schemaVersion: 1,
    version,
    source: { baseTag: data.baseTag, headSha: data.headSha },
    overview: `This release includes updates in ${[...sections.keys()].map((area) => areas[area].replace(/^\S+\s/, '')).join(', ')}.`,
    highlights: ranked
      .slice(0, 5)
      .map(({ title, text, references }) => ({ title, text, references })),
    sections: [...sections].map(([area, items]) => ({ area, items })),
    upgradeNotes: [],
  });
}
