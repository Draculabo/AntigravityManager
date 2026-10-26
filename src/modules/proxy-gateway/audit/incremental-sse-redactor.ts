import { StringDecoder } from 'node:string_decoder';

import { MAX_AUDIT_BODY_BYTES, redactUrlCredentials, sanitizeAuditValue } from './audit-sanitizer';
import { auditJsonObject } from './audit-json-object';

const MAX_EVENT_BYTES = MAX_AUDIT_BODY_BYTES;
const SENSITIVE_JSON_VALUE =
  /((?:"|')?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|credential)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,}\]\r\n]+)/giu;
const SENSITIVE_URL_QUERY =
  /([?&](?:access_token|refresh_token|id_token|api_key|key|client_secret)=)[^&#\s]*/giu;

export interface SseRedactionResult {
  errorSummary: string | null;
  parseErrorOffset: number | null;
  terminalEventSeen: boolean;
}

export interface IncrementalSseRedactorOptions {
  /** Inspect untrusted input synchronously; do not retain or expose its sensitive fields. */
  onRawParsedEvent?: (event: unknown) => void;
  /** Original frame segments without concatenation; null signals the existing event cap. */
  onRawFrame?: (frame: readonly string[] | null) => void;
  onParsedEvent?: (event: unknown) => void;
}

/**
 * Incrementally emits credential-safe SSE shadow data. One protocol event may be held until its
 * framing boundary so valid JSON can be recursively sanitized; it never exceeds the body hard cap.
 */
export class IncrementalSseRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private pendingBytes = 0;
  private discardedLineBytes = 0;
  private pendingCR = false;
  private readonly eventLines: string[] = [];
  private eventBytes = 0;
  private eventStartOffset = 0;
  private rawOffset = 0;
  private failedEvent = false;
  private parseErrorOffset: number | null = null;
  private errorSummary: string | null = null;
  private terminalEventSeen = false;

  public constructor(private readonly options: IncrementalSseRedactorOptions = {}) {}

  public push(chunk: Buffer | string): string[] {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.consumeText(decoded, false);
  }

  public finish(): { chunks: string[]; result: SseRedactionResult } {
    const chunks = this.consumeText(this.decoder.end(), true);
    if (this.pending) {
      this.consumeLine(this.pending, '', chunks);
      this.pending = '';
    }
    if (this.eventLines.length > 0 || this.failedEvent) {
      this.flushEvent('', chunks);
    }
    return {
      chunks,
      result: {
        errorSummary: this.errorSummary,
        parseErrorOffset: this.parseErrorOffset,
        terminalEventSeen: this.terminalEventSeen,
      },
    };
  }

  private consumeText(text: string, final: boolean): string[] {
    const chunks: string[] = [];
    if (this.pendingCR) {
      text = '\r' + text;
      this.pendingCR = false;
    }
    let lineStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character !== '\n' && character !== '\r') {
        continue;
      }
      let ending = character;
      if (character === '\r' && index === text.length - 1 && !final) {
        this.appendPending(text.slice(lineStart, index), chunks);
        this.pendingCR = true;
        return chunks;
      }
      if (character === '\r' && text[index + 1] === '\n') {
        ending = '\r\n';
        index += 1;
      }
      const lineEnd = index - ending.length + 1;
      this.appendPending(text.slice(lineStart, lineEnd), chunks);
      this.consumeLine(this.pending, ending, chunks);
      this.pending = '';
      this.pendingBytes = 0;
      lineStart = index + 1;
    }
    this.appendPending(text.slice(lineStart), chunks);
    if (final && (this.pending || this.discardedLineBytes > 0)) {
      this.consumeLine(this.pending, '', chunks);
      this.pending = '';
      this.pendingBytes = 0;
    }
    return chunks;
  }

  private appendPending(text: string, output: string[]): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (this.failedEvent) {
      this.discardedLineBytes += bytes;
      return;
    }
    if (this.eventBytes + this.pendingBytes + bytes > MAX_EVENT_BYTES) {
      if (this.eventLines.length === 0) {
        this.eventStartOffset = this.rawOffset;
      }
      this.discardedLineBytes = this.pendingBytes + bytes;
      this.pending = '';
      this.pendingBytes = 0;
      this.omitOversizedEvent(output);
      return;
    }
    this.pending += text;
    this.pendingBytes += bytes;
  }

  private omitOversizedEvent(output: string[]): void {
    this.markFailure('SSE event exceeds the incremental JSON event limit');
    this.options.onRawFrame?.(null);
    // Partial token/credential values cannot be safely redacted across arbitrary fragments.
    output.push('data: {"audit":"omitted","reason":"sse_event_limit"}\n');
    this.eventLines.length = 0;
    this.eventBytes = 0;
    this.failedEvent = true;
  }

  private consumeLine(line: string, ending: string, output: string[]): void {
    if (this.discardedLineBytes > 0) {
      this.rawOffset += this.discardedLineBytes + Buffer.byteLength(ending, 'utf8');
      this.discardedLineBytes = 0;
      return;
    }
    const lineBytes = Buffer.byteLength(line + ending, 'utf8');
    if (line === '') {
      this.flushEvent(ending, output);
      this.rawOffset += lineBytes;
      return;
    }
    if (this.failedEvent) {
      this.rawOffset += lineBytes;
      return;
    }
    if (this.eventLines.length === 0) {
      this.eventStartOffset = this.rawOffset;
    }
    this.eventLines.push(line + ending);
    this.eventBytes += lineBytes;
    if (this.eventBytes > MAX_EVENT_BYTES) {
      this.omitOversizedEvent(output);
    }
    this.rawOffset += lineBytes;
  }

  private flushEvent(blankEnding: string, output: string[]): void {
    if (this.failedEvent) {
      output.push(blankEnding);
      this.failedEvent = false;
      this.eventLines.length = 0;
      this.eventBytes = 0;
      return;
    }
    if (this.eventLines.length === 0) {
      this.options.onRawFrame?.([blankEnding]);
      output.push(blankEnding);
      return;
    }

    const rendered = this.renderEvent();
    this.options.onRawFrame?.([...this.eventLines, blankEnding]);
    output.push(rendered + blankEnding);
    this.eventLines.length = 0;
    this.eventBytes = 0;
  }

  private renderEvent(): string {
    const preserved: string[] = [];
    const data: string[] = [];
    let ending = '\n';
    for (const framedLine of this.eventLines) {
      const match = /(\r\n|\r|\n)$/u.exec(framedLine);
      const lineEnding = match?.[1] ?? '';
      if (lineEnding) {
        ending = lineEnding;
      }
      const line = lineEnding ? framedLine.slice(0, -lineEnding.length) : framedLine;
      if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /u, ''));
      } else {
        preserved.push(conservativeMask(line) + lineEnding);
      }
    }
    if (data.length === 0) {
      return preserved.join('');
    }
    const joined = data.join('\n');
    if (joined.trim() === '[DONE]') {
      this.terminalEventSeen = true;
      return preserved.join('') + `data: [DONE]${ending}`;
    }
    try {
      const parsed: unknown = JSON.parse(joined);
      this.options.onRawParsedEvent?.(parsed);
      const sanitized = sanitizeAuditValue(parsed);
      if (isTerminalSseEvent(sanitized)) {
        this.terminalEventSeen = true;
      }
      this.options.onParsedEvent?.(sanitized);
      return preserved.join('') + `data: ${JSON.stringify(sanitized)}${ending}`;
    } catch (error) {
      this.markFailure(error instanceof Error ? error.message : String(error));
      return preserved.join('') + `data: ${conservativeMask(joined)}${ending}`;
    }
  }

  private markFailure(summary: string): void {
    if (this.parseErrorOffset === null) {
      this.parseErrorOffset = this.eventStartOffset;
      this.errorSummary = summary.slice(0, 512);
    }
  }
}

function isTerminalSseEvent(value: unknown): boolean {
  const record = auditJsonObject(value);
  if (!record) {
    return false;
  }
  if (
    record.type === 'message_stop' ||
    record.type === 'response.completed' ||
    record.type === 'response.failed' ||
    record.type === 'response.incomplete'
  ) {
    return true;
  }
  const response = auditJsonObject(record.response);
  if (response) {
    const status = response.status;
    if (status === 'completed' || status === 'failed' || status === 'incomplete') {
      return true;
    }
  }
  const candidates = record.candidates;
  return (
    Array.isArray(candidates) &&
    candidates.some((candidate) => {
      const entry = auditJsonObject(candidate);
      if (!entry) {
        return false;
      }
      const finishReason = entry.finishReason;
      return typeof finishReason === 'string' && finishReason.length > 0;
    })
  );
}

export function conservativeMask(value: string): string {
  return redactUrlCredentials(value)
    .replace(SENSITIVE_URL_QUERY, '$1[REDACTED]')
    .replace(SENSITIVE_JSON_VALUE, '$1"[REDACTED]"');
}
