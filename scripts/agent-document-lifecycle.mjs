import { readFileSync } from 'node:fs';
import path from 'node:path';

const GUIDE_SECTIONS = [
  'Affected users',
  'Required action',
  'Data and recovery',
  'Downgrade',
  'Verification',
];

function read(file) {
  return readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
}

function validDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function metadata(content, name) {
  // Metadata ends at the first section so examples in historical prose are not declarations.
  return content
    .split(/^## /m, 1)[0]
    .split('\n')
    .filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim());
}

function linkedNotes(file, content, name, notes, errors, label) {
  const targets = [];
  for (const value of metadata(content, name)) {
    const match = /^\[[^\]]+\]\(([^\s)#?]+)\)$/.exec(value);
    let target;
    try {
      if (match && !/^(?:[a-z]+:|\/|\\)/i.test(match[1])) {
        target = path.resolve(path.dirname(file), decodeURIComponent(match[1]));
      }
    } catch (error) {
      if (!(error instanceof URIError)) {
        throw error;
      }
      // Invalid encoded links are reported with the declaration that owns them.
    }
    if (!target || target === file || !notes.has(target)) {
      errors.push(`${label}: ${name} must link to a different existing Agent Note.`);
      continue;
    }
    targets.push(target);
  }
  return targets;
}

/** Validate upgrade instructions and explicit note supersession without guessing a change's impact. */
export function validateDocumentLifecycle(rootDir, noteFiles, guideFiles) {
  const errors = [];
  const notes = new Map(
    noteFiles
      .filter((file) => path.basename(file) !== 'README.md')
      .map((file) => [file, read(file)]),
  );
  const notesRoot = path.join(rootDir, '.agents', 'notes');
  const successors = new Map();
  const relative = (file) => path.relative(rootDir, file).split(path.sep).join('/');
  for (const [file, content] of notes) {
    const label = relative(file);
    const lifecycle = path.relative(notesRoot, file).split(path.sep)[0];
    const archived = lifecycle === 'archived';
    const dates = metadata(content, 'Archived');
    if (archived && (dates.length !== 1 || !validDate(dates[0]))) {
      errors.push(`${label}: archived notes require one valid Archived: yyyy-mm-dd declaration.`);
    } else if (!archived && dates.length) {
      errors.push(`${label}: Archived metadata belongs only in the archived directory.`);
    }
    const replacements = linkedNotes(file, content, 'Superseded by', notes, errors, label);
    const predecessors = linkedNotes(file, content, 'Supersedes', notes, errors, label);
    if (metadata(content, 'Superseded by').length > 1 || (archived && replacements.length !== 1)) {
      errors.push(`${label}: a retired note must name one complete replacement.`);
    }
    if ((replacements.length || predecessors.length) && !/^Status: implemented$/m.test(content)) {
      errors.push(`${label}: only implemented decisions can declare supersession.`);
    }
    if (replacements.length === 1) {
      successors.set(file, replacements[0]);
    }
    for (const replacement of replacements) {
      const replacementContent = notes.get(replacement);
      if (
        !['implemented', 'archived'].includes(
          path.relative(notesRoot, replacement).split(path.sep)[0],
        ) ||
        !/^Status: implemented$/m.test(replacementContent)
      ) {
        errors.push(`${label}: replacement must be an implemented decision.`);
      }
      if (
        !linkedNotes(
          replacement,
          replacementContent,
          'Supersedes',
          notes,
          [],
          relative(replacement),
        ).includes(file)
      ) {
        errors.push(`${label}: replacement must link back with Supersedes.`);
      }
    }
    for (const predecessor of predecessors) {
      if (
        !linkedNotes(
          predecessor,
          notes.get(predecessor),
          'Superseded by',
          notes,
          [],
          relative(predecessor),
        ).includes(file)
      ) {
        errors.push(`${label}: predecessor must link back with Superseded by.`);
      }
    }
  }
  for (const file of successors.keys()) {
    const visited = new Set();
    let current = file;
    while (successors.has(current)) {
      if (visited.has(current)) {
        errors.push(`${relative(file)}: supersession must not form a cycle.`);
        break;
      }
      visited.add(current);
      current = successors.get(current);
    }
  }

  for (const file of guideFiles) {
    if (file === path.join(rootDir, 'docs', 'upgrade-guides', 'README.md')) {
      continue;
    }
    const label = relative(file);
    const content = read(file);
    const guidePath = path
      .relative(path.join(rootDir, 'docs', 'upgrade-guides'), file)
      .split(path.sep);
    if (
      guidePath.length !== 2 ||
      !/^(?:next|\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.test(guidePath[0])
    ) {
      errors.push(`${label}: guides belong in <next-or-version>/<topic>.md.`);
    }
    if (!content.startsWith('# Upgrade guide: ')) {
      errors.push(`${label}: first line must start with "# Upgrade guide: ".`);
    }
    const versions = metadata(content, 'Target version');
    if (versions.length !== 1 || versions[0] !== guidePath[0]) {
      errors.push(`${label}: Target version must match its directory.`);
    }
    const sections = new Map(
      content
        .split(/^## /m)
        .slice(1)
        .map((section) => {
          const [heading, ...body] = section.split('\n');
          return [heading, body.join('\n').trim()];
        }),
    );
    for (const section of GUIDE_SECTIONS) {
      const body = sections.get(section);
      if (!body || /^(?:TODO|TBD|\.\.\.)[.!]?$/i.test(body)) {
        errors.push(`${label}: provide a nonempty "## ${section}" section.`);
      }
    }
  }
  return errors;
}
