import { isEmpty, isString } from 'lodash-es';
import type { RequestHeaders } from '../../../guards/api-key-auth.util';

/** Prefer the explicit gateway header; use the first value of a repeated header. */
export function readTargetAccountHeader(headers?: RequestHeaders): string | undefined {
  for (const name of ['x-antigravity-account-id', 'x-account-id']) {
    const raw = headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (isString(value) && !isEmpty(value.trim())) {
      return value.trim();
    }
  }
  return undefined;
}
