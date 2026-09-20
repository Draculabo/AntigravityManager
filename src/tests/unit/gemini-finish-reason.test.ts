import { describe, expect, it } from 'vitest';

import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
  mapGeminiFinishReasonToOpenAI,
} from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';

describe('Gemini finish reason compatibility', () => {
  it('maps a malformed function call to a completed OpenAI stop', () => {
    expect(isMalformedFunctionCallFinishReason('MALFORMED_FUNCTION_CALL')).toBe(true);
    expect(isMalformedFunctionCallFinishReason('malformed_function_call')).toBe(true);
    expect(mapGeminiFinishReasonToOpenAI('MALFORMED_FUNCTION_CALL')).toBe('stop');
    expect(MALFORMED_FUNCTION_CALL_RECOVERY_TEXT).toMatch(/tool call/i);
  });

  it('keeps known end states and converges unknown values to stop', () => {
    expect(mapGeminiFinishReasonToOpenAI('STOP')).toBe('stop');
    expect(mapGeminiFinishReasonToOpenAI('MAX_TOKENS')).toBe('length');
    expect(mapGeminiFinishReasonToOpenAI('SAFETY')).toBe('content_filter');
    expect(mapGeminiFinishReasonToOpenAI('UNRECOGNIZED_PROVIDER_STATE')).toBe('stop');
  });
});
