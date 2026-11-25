import type {
  OpenAIChoice,
  OpenAIResponseFormat,
} from '../../common/interfaces/request-interfaces';

export function isStructuredOpenAIResponseFormat(
  format: OpenAIResponseFormat | undefined,
): boolean {
  return format?.type === 'json_schema' || format?.type === 'json_object';
}

export function normalizeStructuredOpenAIChoice(choice: OpenAIChoice): OpenAIChoice {
  const { content, refusal, tool_calls } = choice.message;
  if (
    choice.finish_reason !== 'stop' ||
    refusal ||
    tool_calls?.length ||
    typeof content !== 'string'
  ) {
    return choice;
  }

  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(content.trim());
  if (fenced?.[1] === undefined) {
    return choice;
  }

  const payload = fenced[1].trim();
  try {
    JSON.parse(payload);
  } catch {
    return choice;
  }
  return { ...choice, message: { ...choice.message, content: payload } };
}
