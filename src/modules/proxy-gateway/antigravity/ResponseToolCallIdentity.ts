import { hashSessionAnchor } from '../../../server/gateway/common/session-anchor-hash';

/**
 * Invocation-local missing-ID identity. The owner supplies a causal request anchor;
 * explicit IDs bypass hashing, including potentially large request/media content.
 */
export class ResponseToolCallIdentity {
  private anchor = '';
  private readRequestAnchor: (() => string) | undefined;

  constructor(readRequestAnchor: () => string) {
    this.readRequestAnchor = readRequestAnchor;
  }

  resolve(name: string, args: object, position: number, suppliedId?: string): string {
    if (suppliedId) {
      return suppliedId;
    }
    if (this.readRequestAnchor) {
      this.anchor = this.readRequestAnchor();
      this.readRequestAnchor = undefined;
    }
    return `call_${hashSessionAnchor([
      'response-tool-call:v1',
      this.anchor,
      position,
      name,
      args,
    ]).slice(0, 32)}`;
  }
}
