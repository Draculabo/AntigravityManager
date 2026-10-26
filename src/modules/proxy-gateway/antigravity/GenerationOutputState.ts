import type { GeminiResponse } from '../server/common/interfaces/request-interfaces';
import { UpstreamGenerationError } from './UpstreamGenerationError';

/** Invocation-local primary-candidate evidence; metadata/signatures do not prove an answer. */
export class GenerationOutputState {
  private thought = false;
  private output = false;
  private finishReason: string | undefined;
  private refusal = false;
  private recoveryBlocked = false;

  get terminal(): boolean {
    return this.refusal || Boolean(this.finishReason);
  }

  get recoveryEligible(): boolean {
    return (
      !this.recoveryBlocked &&
      !this.refusal &&
      this.finishReason === 'STOP' &&
      this.thought &&
      !this.output
    );
  }

  observe(response: GeminiResponse): void {
    this.refusal ||= Boolean(response.promptFeedback?.blockReason);
    this.recoveryBlocked ||= (response.candidates?.length ?? 0) > 1;
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason) {
      this.finishReason = candidate.finishReason.toUpperCase();
    }
    for (const part of candidate?.content?.parts ?? []) {
      this.recoveryBlocked ||= Boolean(part.functionCall) || Boolean(part.inlineData);
      const text = typeof part.text === 'string' && part.text.trim().length > 0;
      this.thought ||= part.thought === true && text;
      this.output ||=
        (part.thought !== true && text) ||
        Boolean(part.functionCall) ||
        Boolean(part.inlineData?.data);
    }
  }

  failure(): UpstreamGenerationError | undefined {
    if (this.refusal || (this.finishReason && this.finishReason !== 'STOP')) {
      return undefined;
    }
    if (!this.finishReason) {
      return new UpstreamGenerationError('incomplete_upstream_response');
    }
    if (!this.output) {
      return new UpstreamGenerationError(
        this.thought ? 'empty_thinking_response' : 'empty_upstream_response',
      );
    }
    return undefined;
  }
}
