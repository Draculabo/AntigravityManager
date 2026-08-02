export function sanitizeSystemInstructionForCache(text: string): string {
  return text
    .replace(/^Current (?:date|time)(?:\s+is)?\s*:.*$/gim, '')
    .replace(/^Today is\s*:.*$/gim, '')
    .replace(/^Date:\s+\d{4}-\d{2}-\d{2}.*$/gim, '')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, '{uuid}')
    .replace(/\b(?:req|sid|trace)_[a-f0-9]{6,32}\b/gi, '{id}')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
