export interface PromptRange {
  start: number;
  end: number;
}

/** Byte-preserving spans for Markdown code/quotes and explicit XML example regions. */
export function promptProtectedRegions(text: string): PromptRange[] {
  const ranges: PromptRange[] = [];
  let fence: { start: number; marker: string; width: number } | undefined;
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, end).replace(/\r?\n$/u, '');
    const marker = /^[\t ]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.marker && marker.length >= fence.width && line.trim() === marker) {
        ranges.push({ start: fence.start, end });
        fence = undefined;
      }
    } else if (marker) {
      fence = { start, marker: marker[0], width: marker.length };
    } else if (/^[\t ]*>/u.test(line)) {
      ranges.push({ start, end });
    }
    start = end;
  }
  if (fence) {
    ranges.push({ start: fence.start, end: text.length });
  }

  let fencedIndex = 0;
  const xml: Array<{ tag: string; start: number }> = [];
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?(quote|quoted|example|examples|code|pre)\b[^>]*>/giu;
  for (const match of text.matchAll(tags)) {
    while (ranges[fencedIndex] && ranges[fencedIndex].end <= match.index) {
      fencedIndex++;
    }
    if (ranges[fencedIndex] && ranges[fencedIndex].start <= match.index) {
      continue;
    }
    if (match[0].startsWith('<!--')) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    } else if (match[0].startsWith('</')) {
      if (xml.at(-1)?.tag === match[1].toLowerCase()) {
        const opened = xml.pop();
        if (opened && xml.length === 0) {
          ranges.push({ start: opened.start, end: match.index + match[0].length });
        }
      }
    } else if (!match[0].endsWith('/>')) {
      xml.push({ tag: match[1].toLowerCase(), start: match.index });
    }
  }
  if (xml.length) {
    ranges.push({ start: xml[0].start, end: text.length });
  }
  ranges.sort((a, b) => a.start - b.start);

  let rangeIndex = 0;
  for (let cursor = 0; cursor < text.length; ) {
    const start = text.indexOf('`', cursor);
    if (start < 0) {
      break;
    }
    while (ranges[rangeIndex] && ranges[rangeIndex].end <= start) {
      rangeIndex++;
    }
    if (ranges[rangeIndex] && ranges[rangeIndex].start <= start) {
      cursor = ranges[rangeIndex].end;
      continue;
    }
    let after = start;
    while (text[after] === '`') {
      after++;
    }
    const width = after - start;
    const newline = text.indexOf('\n', after);
    const lineEnd = newline < 0 ? text.length : newline;
    let closing = text.indexOf('`', after);
    let matched = false;
    while (closing >= 0 && closing < lineEnd) {
      let end = closing;
      while (text[end] === '`') {
        end++;
      }
      if (end - closing === width) {
        ranges.push({ start, end });
        cursor = end;
        matched = true;
        break;
      }
      closing = text.indexOf('`', end);
    }
    if (!matched) {
      cursor = lineEnd + 1;
    }
  }
  const merged: PromptRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.end >= range.start) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function overlapsPromptProtection(
  ranges: readonly PromptRange[],
  start: number,
  end: number,
): boolean {
  // The scanner merges nested spans, so the preceding interval is sufficient.
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].start < end) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low > 0 && ranges[low - 1].end > start;
}
