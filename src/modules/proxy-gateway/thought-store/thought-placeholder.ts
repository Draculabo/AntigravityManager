export function isPlaceholderThought(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (
    normalized === '...' ||
    normalized === '.' ||
    normalized === '·' ||
    normalized === '···' ||
    normalized === '[undefined]' ||
    normalized === 'applying tool decisions and generating response...'
  ) {
    return true;
  }
  return /^[.·…]+$/u.test(normalized);
}
