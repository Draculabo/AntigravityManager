import { isEmpty, isString } from 'lodash-es';

export function hasConfiguredApiKey(apiKey: string | undefined): apiKey is string {
  return isString(apiKey) && !isEmpty(apiKey.trim());
}
