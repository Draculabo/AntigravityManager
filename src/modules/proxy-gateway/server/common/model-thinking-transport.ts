/** The selected account's declared thinking channel, independent of request control source. */
export type ModelThinkingTransport =
  | { kind: 'disabled' }
  | { kind: 'level'; defaultLevel: 'low' | 'medium' | 'high' }
  | { kind: 'budget'; defaultBudget: number };
