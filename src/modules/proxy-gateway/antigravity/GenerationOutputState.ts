import type { GeminiResponse } from '../../../server/gateway/common/interfaces/request-interfaces';
import { UpstreamGenerationError } from './UpstreamGenerationError';

export type GenerationStreamPhase = 'waiting_for_output' | 'thinking_only' | 'output_started';

/** Invocation-local primary-candidate evidence; metadata/signatures do not prove an answer. */
export class GenerationOutputState {
  private thought = false;
  private output = false;
  private text = false;
  private tool = false;
  private media = false;
  private multipleCandidates = false;
  private finishReason: string | undefined;
  private refusal = false;
  private recoveryBlocked = false;

  get streamPhase(): GenerationStreamPhase {
    if (this.output) {
      return 'output_started';
    }
    return this.thought ? 'thinking_only' : 'waiting_for_output';
  }

  get terminal(): boolean {
    return this.refusal || Boolean(this.finishReason);
  }

  /** A transport interruption may finish only previously validated text or complete tool calls. */
  get interruptionFinishReason(): 'STOP' | 'MAX_TOKENS' | undefined {
    if (
      this.refusal ||
      this.multipleCandidates ||
      this.media ||
      (this.finishReason && this.finishReason !== 'STOP' && this.finishReason !== 'MAX_TOKENS')
    ) {
      return undefined;
    }
    if (this.tool) {
      return 'STOP';
    }
    return this.text ? 'MAX_TOKENS' : undefined;
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
    this.multipleCandidates ||= (response.candidates?.length ?? 0) > 1;
    this.recoveryBlocked ||= this.multipleCandidates;
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason) {
      this.finishReason = candidate.finishReason.toUpperCase();
    }
    for (const part of candidate?.content?.parts ?? []) {
      this.recoveryBlocked ||= Boolean(part.functionCall) || Boolean(part.inlineData);
      const text = typeof part.text === 'string' && part.text.trim().length > 0;
      this.thought ||= part.thought === true && text;
      this.text ||= part.thought !== true && text;
      this.tool ||= Boolean(part.functionCall);
      this.media ||= Boolean(part.inlineData?.data);
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
