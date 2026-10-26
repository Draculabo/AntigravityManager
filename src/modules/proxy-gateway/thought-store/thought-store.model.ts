import {
  areThoughtSignatureModelsCompatible,
  normalizeThoughtSignatureModelContext,
} from '../antigravity/thought-signature-model';
import type { ThoughtRecordInput } from './thought-store.types';

/**
 * Recompute compatibility from the recorded physical models. Legacy sourceFamily
 * values such as "claude" and "gemini-3" do not prove signature interchangeability.
 */
export function areThoughtRecordModelsCompatible(
  source: Pick<ThoughtRecordInput, 'model'>,
  target: Pick<ThoughtRecordInput, 'model'>,
): boolean {
  const sourceContext = normalizeThoughtSignatureModelContext({ model: source.model ?? '' });
  const targetContext = normalizeThoughtSignatureModelContext({ model: target.model ?? '' });
  return Boolean(
    sourceContext &&
    targetContext &&
    areThoughtSignatureModelsCompatible(sourceContext, targetContext),
  );
}
