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
  onParsedEvent?: (event: unknown) => void;
}

/**
 * Incrementally emits credential-safe SSE shadow data. One protocol event may be held until its
 * framing boundary so valid JSON can be recursively sanitized; it never exceeds the body hard cap.
 */
export class IncrementalSseRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
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
    const chunks = this.consumeText(this.decoder.end(), false);
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
    this.pending += text;
    let lineStart = 0;
    for (let index = 0; index < this.pending.length; index += 1) {
      const character = this.pending[index];
      if (character !== '\n' && character !== '\r') {
        continue;
      }
      let ending = character;
      if (character === '\r' && this.pending[index + 1] === '\n') {
        ending = '\r\n';
        index += 1;
      }
      const lineEnd = index - ending.length + 1;
      this.consumeLine(this.pending.slice(lineStart, lineEnd), ending, chunks);
      lineStart = index + 1;
    }
    this.pending = this.pending.slice(lineStart);
    if (final && this.pending) {
      this.consumeLine(this.pending, '', chunks);
      this.pending = '';
    }
    return chunks;
  }

  private consumeLine(line: string, ending: string, output: string[]): void {
    const lineBytes = Buffer.byteLength(line + ending, 'utf8');
    if (line === '') {
      this.flushEvent(ending, output);
      this.rawOffset += lineBytes;
      return;
    }
    if (this.failedEvent) {
      output.push(conservativeMask(line) + ending);
      this.rawOffset += lineBytes;
      return;
    }
    if (this.eventLines.length === 0) {
      this.eventStartOffset = this.rawOffset;
    }
    this.eventLines.push(line + ending);
    this.eventBytes += lineBytes;
    if (this.eventBytes > MAX_EVENT_BYTES) {
      this.markFailure('SSE event exceeds the incremental JSON event limit');
      for (const framedLine of this.eventLines) {
        output.push(conservativeMask(framedLine));
      }
      this.eventLines.length = 0;
      this.eventBytes = 0;
      this.failedEvent = true;
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
      output.push(blankEnding);
      return;
    }

    const rendered = this.renderEvent();
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
