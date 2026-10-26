import { BadRequestException } from '@nestjs/common';

const OUTPUT_TOKEN_LIMIT_FIELDS = [
  'max_tokens',
  'max_completion_tokens',
  'maxCompletionTokens',
  'maxTokens',
  'max_output_tokens',
] as const;

type OutputTokenLimitField = (typeof OUTPUT_TOKEN_LIMIT_FIELDS)[number];

export class OutputTokenLimitConflictError extends BadRequestException {
  constructor(readonly fields: readonly OutputTokenLimitField[]) {
    super(
      `Conflicting output token limits were provided: ${fields.join(', ')}. ` +
        'Provide one value or equivalent values for all aliases.',
    );
    this.name = 'OutputTokenLimitConflictError';
  }
}

function isValidOutputTokenLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Resolve the supported output-limit aliases without mutating the caller's request.
 *
 * Missing aliases are ignored. Explicit invalid values remain a boundary error, while
 * equivalent numeric aliases are accepted and normalized to one value.
 */
export function resolveOutputTokenLimit(input: object): number | undefined {
  const provided = OUTPUT_TOKEN_LIMIT_FIELDS.flatMap((field) => {
    if (!(field in input)) {
      return [];
    }
    const value = Reflect.get(input, field);
    if (!isValidOutputTokenLimit(value)) {
      throw new BadRequestException(`${field} must be a positive safe integer`);
    }
    return [{ field, value }];
  });

  if (provided.length === 0) {
    return undefined;
  }

  const firstValue = provided[0].value;
  if (provided.some((entry) => entry.value !== firstValue)) {
    throw new OutputTokenLimitConflictError(provided.map((entry) => entry.field));
  }

  return firstValue;
}
