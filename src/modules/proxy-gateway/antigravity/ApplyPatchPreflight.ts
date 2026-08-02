export interface ApplyPatchRepair {
  file: string;
  kind: string;
  detail: string;
}

export interface ApplyPatchOptimizationResult {
  input: string;
  repairs: ApplyPatchRepair[];
}

export interface ApplyPatchValidationError {
  line: number;
  message: string;
}

const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';
const PATCH_OPERATIONS = ['*** Add File: ', '*** Update File: ', '*** Delete File: '] as const;
const UNIFIED_HUNK_RANGE_PATTERN = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)?(?: @@)?$/u;

function normalizeUnifiedPath(value: string): string | undefined {
  const path = value.trim().split(/\s+/u)[0];
  if (!path || path === '/dev/null') {
    return undefined;
  }

  return path.replace(/^(?:a|b)\//u, '');
}

function convertUnifiedFileHeaders(lines: string[], repairs: ApplyPatchRepair[]): string[] {
  const result: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];
    if (current.startsWith('--- ') && next?.startsWith('+++ ')) {
      const file = normalizeUnifiedPath(next.slice(4)) ?? normalizeUnifiedPath(current.slice(4));
      if (file) {
        result.push(`*** Update File: ${file}`);
        repairs.push({
          file,
          kind: 'converted-unified-file-header',
          detail: 'Converted ---/+++ headers to *** Update File.',
        });
        index += 1;
        continue;
      }
    }

    const fileHeader = current.match(/^file:\s*(.+)$/iu);
    if (fileHeader) {
      const file = normalizeUnifiedPath(fileHeader[1]);
      if (file) {
        result.push(`*** Update File: ${file}`);
        repairs.push({
          file,
          kind: 'converted-file-header',
          detail: 'Converted file: header to *** Update File.',
        });
        continue;
      }
    }

    result.push(current);
  }

  return result;
}

function stripUnifiedHunkRanges(lines: string[], repairs: ApplyPatchRepair[]): string[] {
  let currentFile = '';

  return lines.map((line) => {
    const operation = PATCH_OPERATIONS.find((prefix) => line.startsWith(prefix));
    if (operation) {
      currentFile = line.slice(operation.length).trim();
    }

    if (UNIFIED_HUNK_RANGE_PATTERN.test(line)) {
      repairs.push({
        file: currentFile,
        kind: 'removed-unified-hunk-range',
        detail: 'Removed line ranges from unified hunk header.',
      });
      return '@@';
    }

    if (/^@@ .+ @@$/u.test(line)) {
      repairs.push({
        file: currentFile,
        kind: 'removed-closing-hunk-marker',
        detail: 'Removed unsupported closing @@ marker from named hunk.',
      });
      return line.slice(0, -3);
    }

    return line;
  });
}

function normalizeAddFileLines(lines: string[], repairs: ApplyPatchRepair[]): string[] {
  let addFile: string | undefined;
  const repairedFiles = new Set<string>();

  return lines.map((line) => {
    if (line.startsWith('*** Add File: ')) {
      addFile = line.slice('*** Add File: '.length).trim();
      return line;
    }

    if (line.startsWith('*** ')) {
      addFile = undefined;
      return line;
    }

    if (addFile && !line.startsWith('+')) {
      if (!repairedFiles.has(addFile)) {
        repairs.push({
          file: addFile,
          kind: 'prefixed-add-file-lines',
          detail: 'Added the required + prefix to Add File content.',
        });
        repairedFiles.add(addFile);
      }
      return `+${line}`;
    }

    return line;
  });
}

function ensurePatchEnvelope(lines: string[], repairs: ApplyPatchRepair[]): string[] {
  const firstMeaningfulLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstMeaningfulLine < 0) {
    return lines;
  }

  const firstLine = lines[firstMeaningfulLine].trim();
  const startsWithOperation = PATCH_OPERATIONS.some((operation) => firstLine.startsWith(operation));
  if (firstLine !== PATCH_BEGIN && !startsWithOperation) {
    return lines;
  }

  const result = [...lines];
  if (firstLine !== PATCH_BEGIN) {
    result.splice(firstMeaningfulLine, 0, PATCH_BEGIN);
    repairs.push({
      file: '',
      kind: 'added-patch-envelope',
      detail: `Added missing ${PATCH_BEGIN} marker.`,
    });
  }

  let lastMeaningfulLine = result.length - 1;
  while (lastMeaningfulLine >= 0 && result[lastMeaningfulLine].trim().length === 0) {
    lastMeaningfulLine -= 1;
  }
  if (result[lastMeaningfulLine]?.trim() !== PATCH_END) {
    result.splice(lastMeaningfulLine + 1, 0, PATCH_END);
    repairs.push({
      file: '',
      kind: 'added-patch-envelope',
      detail: `Added missing ${PATCH_END} marker.`,
    });
  }

  return result;
}

export function optimizeApplyPatch(input: string): ApplyPatchOptimizationResult {
  const repairs: ApplyPatchRepair[] = [];
  const hasTrailingNewline = input.endsWith('\n');
  const lines = ensurePatchEnvelope(
    normalizeAddFileLines(
      stripUnifiedHunkRanges(convertUnifiedFileHeaders(input.split(/\r?\n/u), repairs), repairs),
      repairs,
    ),
    repairs,
  );
  const optimized = lines.join('\n');

  return {
    input: hasTrailingNewline && !optimized.endsWith('\n') ? `${optimized}\n` : optimized,
    repairs,
  };
}

export function validateApplyPatchV4A(input: string): ApplyPatchValidationError | null {
  const lines = input.split(/\r?\n/u);
  const firstMeaningfulLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstMeaningfulLine < 0 || lines[firstMeaningfulLine].trim() !== PATCH_BEGIN) {
    return {
      line: Math.max(firstMeaningfulLine + 1, 1),
      message: `Patch must start with ${PATCH_BEGIN}.`,
    };
  }

  let lastMeaningfulLine = lines.length - 1;
  while (lastMeaningfulLine >= 0 && lines[lastMeaningfulLine].trim().length === 0) {
    lastMeaningfulLine -= 1;
  }
  if (lastMeaningfulLine < 0 || lines[lastMeaningfulLine].trim() !== PATCH_END) {
    return {
      line: Math.max(lastMeaningfulLine + 1, 1),
      message: `Patch must end with ${PATCH_END}.`,
    };
  }

  const hasOperation = lines.some((line) =>
    PATCH_OPERATIONS.some((operation) => line.startsWith(operation)),
  );
  if (!hasOperation) {
    return {
      line: firstMeaningfulLine + 1,
      message: 'Patch must contain at least one Add, Update, or Delete File operation.',
    };
  }

  for (let index = firstMeaningfulLine + 1; index < lastMeaningfulLine; index += 1) {
    const line = lines[index];
    if (line.trim() === PATCH_BEGIN || line.trim() === PATCH_END) {
      return {
        line: index + 1,
        message: 'Patch envelope markers may only appear once.',
      };
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      return {
        line: index + 1,
        message: 'Unified diff file headers are not valid V4A syntax.',
      };
    }

    if (UNIFIED_HUNK_RANGE_PATTERN.test(line)) {
      return {
        line: index + 1,
        message: 'Unified diff hunk ranges are not valid V4A syntax.',
      };
    }

    const isRecognizedControlMarker =
      PATCH_OPERATIONS.some((operation) => line.startsWith(operation)) ||
      line.startsWith('*** Move to: ') ||
      line === '*** End of File';
    if (line.startsWith('*** ') && !isRecognizedControlMarker) {
      return {
        line: index + 1,
        message: 'Unrecognized V4A patch control marker.',
      };
    }

    if (
      line === '@@' ||
      line.startsWith('@@ ') ||
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith(' ') ||
      isRecognizedControlMarker
    ) {
      continue;
    }

    return {
      line: index + 1,
      message: 'Patch content line is missing a V4A prefix.',
    };
  }

  return null;
}
