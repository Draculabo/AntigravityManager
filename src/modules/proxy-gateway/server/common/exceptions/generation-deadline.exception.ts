/** A logical generation deadline is terminal and must not penalize an account. */
export class GenerationDeadlineExceededError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor() {
    super('Generation request deadline exceeded.');
    this.name = 'GenerationDeadlineExceededError';
  }
}
