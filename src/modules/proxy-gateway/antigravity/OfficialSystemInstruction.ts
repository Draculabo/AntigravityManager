interface SystemInstructionSections {
  identity: string[];
  environmentPermissions: string[];
  appContext: string[];
  customizations: string[];
  skills: string[];
  plugins: string[];
  memory: string[];
  planningMode: string[];
  communicationStyle: string[];
}

const SECTION_TAGS = [
  ['permissions instructions', 'environmentPermissions'],
  ['app-context', 'appContext'],
  ['skills_instructions', 'skills'],
  ['plugins_instructions', 'plugins'],
  ['collaboration_mode', 'planningMode'],
] as const satisfies ReadonlyArray<readonly [string, keyof SystemInstructionSections]>;

const COMMUNICATION_MARKERS = [
  '# Working with the user',
  '## Formatting rules',
  '## Final answer instructions',
  '## Intermediary updates',
] as const;

const IDENTITY_MARKERS = [
  'You are Codex',
  'You are Antigravity',
  'You are a search engine bot',
] as const;

/**
 * Classifies existing system/developer instructions into the section layout used
 * by Antigravity requests. Content is preserved rather than summarized because
 * permissions, skills and memory are executable behavior contracts.
 */
export function buildOfficialSystemInstruction(
  instructions: string[],
  fallbackIdentity: string,
): string {
  const sections: SystemInstructionSections = {
    identity: [],
    environmentPermissions: [],
    appContext: [],
    customizations: [],
    skills: [],
    plugins: [],
    memory: [],
    planningMode: [],
    communicationStyle: [],
  };

  for (const instruction of instructions) {
    classifyInstruction(instruction, sections);
  }

  if (sections.identity.length === 0 && fallbackIdentity.trim()) {
    sections.identity.push(fallbackIdentity);
  }

  return renderSections(sections);
}

function classifyInstruction(instruction: string, sections: SystemInstructionSections): void {
  let remaining = stripCodexStepMarkers(instruction);

  for (const [sourceTag, targetSection] of SECTION_TAGS) {
    const extracted = extractTaggedBlocks(remaining, sourceTag);
    remaining = extracted.remaining;
    sections[targetSection].push(...extracted.blocks);
  }

  const memory = extractMemoryBlock(remaining);
  remaining = memory.remaining;
  if (memory.content) {
    sections.memory.push(memory.content);
  }

  remaining = collapseBlankLines(remaining);
  if (!remaining) {
    return;
  }

  if (containsIdentity(remaining)) {
    const split = splitIdentityAndCommunication(remaining);
    if (split.identity) {
      sections.identity.push(split.identity);
    }
    if (split.communicationStyle) {
      sections.communicationStyle.push(split.communicationStyle);
    }
    return;
  }

  sections.customizations.push(remaining);
}

function extractTaggedBlocks(
  text: string,
  tag: string,
): {
  blocks: string[];
  remaining: string;
} {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const blocks: string[] = [];
  let remainingInput = text;
  let output = '';

  while (true) {
    const start = remainingInput.indexOf(startTag);
    if (start < 0) {
      output += remainingInput;
      break;
    }

    output += remainingInput.slice(0, start);
    const afterStart = remainingInput.slice(start + startTag.length);
    const end = afterStart.indexOf(endTag);
    if (end < 0) {
      output += afterStart;
      break;
    }

    const block = afterStart.slice(0, end).trim();
    if (block) {
      blocks.push(block);
    }
    remainingInput = afterStart.slice(end + endTag.length);
  }

  return {
    blocks,
    remaining: output,
  };
}

function extractMemoryBlock(text: string): {
  content: string | null;
  remaining: string;
} {
  const start = text.indexOf('## Memory');
  if (start < 0) {
    return {
      content: null,
      remaining: text,
    };
  }

  const content = text.slice(start).trim();
  return {
    content: content || null,
    remaining: text.slice(0, start),
  };
}

function splitIdentityAndCommunication(text: string): {
  communicationStyle: string | null;
  identity: string;
} {
  for (const marker of COMMUNICATION_MARKERS) {
    const index = text.indexOf(marker);
    if (index >= 0) {
      return {
        communicationStyle: text.slice(index).trim() || null,
        identity: text.slice(0, index).trim(),
      };
    }
  }

  return {
    communicationStyle: null,
    identity: text.trim(),
  };
}

function containsIdentity(text: string): boolean {
  return IDENTITY_MARKERS.some((marker) => text.includes(marker));
}

function renderSections(sections: SystemInstructionSections): string {
  const output: string[] = [];

  appendSection(output, 'identity', joinDeduplicated(sections.identity));
  appendSection(
    output,
    'environment_permissions',
    joinDeduplicated(sections.environmentPermissions),
  );
  appendSection(output, 'app_context', joinDeduplicated(sections.appContext));
  appendSection(output, 'customizations', joinDeduplicated(sections.customizations));
  appendSection(output, 'skills', joinDeduplicated(sections.skills));
  appendSection(output, 'plugins', joinDeduplicated(sections.plugins));
  appendSection(output, 'memory', joinDeduplicated(sections.memory));
  appendSection(output, 'planning_mode', joinDeduplicated(sections.planningMode));
  appendSection(output, 'communication_style', joinDeduplicated(sections.communicationStyle));

  return output.join('\n');
}

function appendSection(output: string[], tag: string, content: string): void {
  if (!content) {
    return;
  }
  output.push(`<${tag}>\n${content}\n</${tag}>`);
}

function joinDeduplicated(items: string[]): string {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const cleaned = collapseBlankLines(stripCodexStepMarkers(item));
    const dedupeKey = cleaned.split(/\s+/).join(' ');
    if (cleaned && !seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      result.push(cleaned);
    }
  }

  return result.join('\n\n');
}

function stripCodexStepMarkers(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*\[codex-turn:[^\]]+\s+step:[^\]]+\s+type:[^\]]+\](?:\s+tool:\S+)?(?:\s+call_id:\S+)?\s*$/.test(
          line,
        ),
    )
    .join('\n');
}

function collapseBlankLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
