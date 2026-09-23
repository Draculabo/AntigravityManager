import { auditJsonObject } from './audit-json-object';

export interface AuditOutputModalities {
  hasImage: boolean;
  hasText: boolean;
}

function combineModalities(
  left: AuditOutputModalities | null,
  right: AuditOutputModalities | null,
) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return { hasImage: left.hasImage || right.hasImage, hasText: left.hasText || right.hasText };
}

/** Only inspect protocol output positions; inputs, tool arguments and thought text are not output. */
export function detectAuditOutputModalities(value: unknown): AuditOutputModalities | null {
  const root = auditJsonObject(value);
  if (!root) {
    return null;
  }
  if (auditJsonObject(root.response)) {
    return detectAuditOutputModalities(root.response);
  }
  if (Array.isArray(root.events)) {
    return root.events.reduce<AuditOutputModalities | null>(
      (current, event) => combineModalities(current, detectAuditOutputModalities(event)),
      null,
    );
  }
  if (Array.isArray(root.candidates)) {
    return scanList(root.candidates, (candidate) => {
      const entry = auditJsonObject(candidate);
      return scanOutput(auditJsonObject(entry?.content)?.parts);
    });
  }
  if (Array.isArray(root.choices)) {
    return scanList(root.choices, (choice) => {
      const entry = auditJsonObject(choice);
      return scanOutput(entry?.message ?? entry?.delta ?? entry?.text);
    });
  }
  if (Array.isArray(root.output)) {
    return scanOutput(root.output);
  }
  if (Array.isArray(root.content)) {
    return scanOutput(root.content);
  }
  if (
    Array.isArray(root.data) &&
    root.data.some((item) => hasVisibleText(auditJsonObject(item)?.b64_json))
  ) {
    return { hasImage: true, hasText: false };
  }
  const type = typeof root.type === 'string' ? root.type : '';
  if (type === 'response.completed') {
    return detectAuditOutputModalities(root.response);
  }
  if (type.startsWith('response.output_text.')) {
    return scanOutput(root.delta ?? root.text);
  }
  if (type.includes('image_generation_call') || type.includes('output_image')) {
    return { hasImage: true, hasText: false };
  }
  if (type === 'response.output_item.added' || type === 'response.content_part.added') {
    return scanOutput(root.item ?? root.part);
  }
  if (type === 'content_block_start') {
    return scanOutput(root.content_block);
  }
  if (type === 'content_block_delta') {
    return scanOutput(root.delta);
  }
  if (type === 'message_start') {
    return detectAuditOutputModalities(root.message);
  }
  if (type.startsWith('message_') || type.startsWith('response.')) {
    return { hasImage: false, hasText: false };
  }
  return null;
}

function scanList(
  values: unknown[],
  scan: (value: unknown) => AuditOutputModalities,
): AuditOutputModalities {
  let result: AuditOutputModalities = { hasImage: false, hasText: false };
  for (const value of values.slice(0, 2000)) {
    result = combineModalities(result, scan(value)) ?? result;
  }
  return result;
}

function scanOutput(value: unknown, depth = 0): AuditOutputModalities {
  if (depth > 16) {
    return { hasImage: false, hasText: false };
  }
  if (typeof value === 'string') {
    if (value.startsWith('data:image/')) {
      return { hasImage: true, hasText: false };
    }
    const textWithoutImages = value.replace(/!\[[^\]]*\]\(data:image\/[^)]*\)/giu, '');
    return { hasImage: textWithoutImages !== value, hasText: hasVisibleText(textWithoutImages) };
  }
  if (Array.isArray(value)) {
    return scanList(value, (entry) => scanOutput(entry, depth + 1));
  }
  const entry = auditJsonObject(value);
  if (!entry || entry.thought === true) {
    return { hasImage: false, hasText: false };
  }
  const type = typeof entry.type === 'string' ? entry.type : '';
  if (
    type.includes('thinking') ||
    type.includes('reasoning') ||
    type.includes('tool') ||
    type.includes('function_call')
  ) {
    return { hasImage: false, hasText: false };
  }
  const inline = auditJsonObject(entry.inlineData) ?? auditJsonObject(entry.inline_data);
  const mimeType = inline?.mimeType ?? inline?.mime_type ?? entry.mimeType ?? entry.mime_type;
  const hasImage =
    type.includes('image') ||
    (typeof mimeType === 'string' && mimeType.startsWith('image/')) ||
    entry.image_url !== undefined;
  const text = entry.text ?? entry.output_text ?? entry.content;
  const visibleText = typeof text === 'string' ? scanOutput(text, depth + 1) : null;
  const nested = scanOutput(entry.parts ?? (typeof text === 'string' ? null : text), depth + 1);
  return {
    hasImage: hasImage || Boolean(visibleText?.hasImage) || nested.hasImage,
    hasText: Boolean(visibleText?.hasText) || nested.hasText,
  };
}

function hasVisibleText(value: unknown): boolean {
  return typeof value === 'string' && /\S/u.test(value);
}

export function mergeAuditOutputModalities(
  left: AuditOutputModalities | null,
  right: AuditOutputModalities | null,
): AuditOutputModalities | null {
  return combineModalities(left, right);
}
