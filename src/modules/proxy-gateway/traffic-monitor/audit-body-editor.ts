import { json } from '@codemirror/lang-json';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { TrafficAuditBodyDescriptor } from '../audit/traffic-audit.types';

export function auditBodyExtensions(
  body: TrafficAuditBodyDescriptor | null,
  previewOnly: boolean,
  wrapLines = true,
): Extension[] {
  const result: Extension[] = wrapLines ? [EditorView.lineWrapping] : [];
  if (body?.kind === 'json' && !previewOnly) {
    result.push(json());
  }
  if (body?.parseErrorOffset !== null && body?.parseErrorOffset !== undefined) {
    const offset = body.parseErrorOffset;
    result.push(
      EditorView.decorations.compute([], (state) => {
        const position = Math.min(offset, state.doc.length);
        return Decoration.set([
          Decoration.line({ attributes: { class: 'cm-traffic-parse-error-line' } }).range(
            state.doc.lineAt(position).from,
          ),
        ]);
      }),
      EditorView.baseTheme({
        '.cm-traffic-parse-error-line': {
          backgroundColor: 'color-mix(in srgb, var(--destructive) 12%, transparent)',
          boxShadow: 'inset 3px 0 0 var(--destructive)',
        },
      }),
    );
  }
  return result;
}

export function utf8Prefix(value: string, byteLimit: number): string {
  let bytes = 0;
  let prefix = '';
  for (const character of value) {
    const characterBytes = new TextEncoder().encode(character).byteLength;
    if (bytes + characterBytes > byteLimit) {
      break;
    }
    prefix += character;
    bytes += characterBytes;
  }
  return prefix;
}
