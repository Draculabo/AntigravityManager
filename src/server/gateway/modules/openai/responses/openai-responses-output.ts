import type { ResponsesOutputStatus } from './openai-responses-incomplete';

export interface ResponsesOutputTextPart {
  annotations: [];
  text: string;
  type: 'output_text';
}

export interface ResponsesReasoningOutputItem {
  id: string;
  status: ResponsesOutputStatus;
  summary: Array<{
    text: string;
    type: 'summary_text';
  }>;
  type: 'reasoning';
}
