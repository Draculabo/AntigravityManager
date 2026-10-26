// Reserve room for exact signature/range metadata within the 64 MiB session budget.
export const LARGE_THOUGHT_BYTES = 64 * 1024 * 1024 - 1024;
export const LARGE_THOUGHT_SESSION = 'installed-capacity-thought';
export const LARGE_THOUGHT_SIGNATURE = 'A'.repeat(64);
