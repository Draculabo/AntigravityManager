import {
  DesktopOAuthCodeSchema,
  DesktopOAuthManualInputSchema,
} from './desktop-oauth-login.schema';

export type ManualOAuthInput =
  | { kind: 'code'; code: string }
  | { kind: 'callback'; code: string; state: string }
  | { kind: 'denied'; state: string };

/** Contains no pasted authorization data and leaves the current session available for retry. */
export class InvalidManualOAuthInputError extends Error {
  constructor() {
    super('Invalid OAuth completion input');
    this.name = 'InvalidManualOAuthInputError';
  }
}

/** Interpret text only; callback addresses never replace the session's exchange redirect. */
export function parseManualOAuthInput(input: string): ManualOAuthInput {
  const bounded = DesktopOAuthManualInputSchema.safeParse(input);
  if (!bounded.success) {
    throw new InvalidManualOAuthInputError();
  }
  const text = bounded.data;
  if (
    [...text].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new InvalidManualOAuthInputError();
  }
  let query: string | undefined;
  if (
    /^https?:\/\//iu.test(text) ||
    /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[/?]/iu.test(text)
  ) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//iu.test(text) ? text : `http://${text}`);
    } catch {
      throw new InvalidManualOAuthInputError();
    }
    if (url.hash || url.username || url.password) {
      throw new InvalidManualOAuthInputError();
    }
    query = url.search.slice(1);
  } else if (/^(?:\?|code=|state=|error=)/u.test(text)) {
    if (text.includes('#')) {
      throw new InvalidManualOAuthInputError();
    }
    query = text.startsWith('?') ? text.slice(1) : text;
  }

  if (query !== undefined) {
    // URLSearchParams tolerates malformed escapes. Reject them before its form decoding.
    try {
      decodeURIComponent(query.replaceAll('+', ' '));
    } catch {
      throw new InvalidManualOAuthInputError();
    }
    const params = new URLSearchParams(query);
    const states = params.getAll('state');
    const codes = params.getAll('code');
    const errors = params.getAll('error');
    if (states.length !== 1 || !states[0]) {
      throw new InvalidManualOAuthInputError();
    }
    if (errors.length === 1 && errors[0] === 'access_denied' && codes.length === 0) {
      return { kind: 'denied', state: states[0] };
    }
    if (
      errors.length ||
      codes.length !== 1 ||
      !DesktopOAuthCodeSchema.safeParse(codes[0]).success
    ) {
      throw new InvalidManualOAuthInputError();
    }
    return { kind: 'callback', code: codes[0], state: states[0] };
  }

  let code = text;
  try {
    // A bare code is not form data: literal '+' must not become a space.
    code = decodeURIComponent(text);
  } catch {
    throw new InvalidManualOAuthInputError();
  }
  if (!DesktopOAuthCodeSchema.safeParse(code).success) {
    throw new InvalidManualOAuthInputError();
  }
  return { kind: 'code', code };
}
