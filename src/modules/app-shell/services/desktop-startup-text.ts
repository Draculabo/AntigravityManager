/** Only loaded on a startup failure, before a renderer translator is available. */
export async function getDesktopStartupErrorTexts(
  language: string,
  kind: 'core-unavailable' | 'account-data-unavailable' | 'already-running',
) {
  let resource: {
    default: {
      common: Record<
        `${'core-unavailable' | 'account-data-unavailable' | 'already-running'}-${'title' | 'body'}`,
        string
      >;
    };
  };
  switch (language.slice(0, 2)) {
    case 'zh':
      resource = await import('@/localization/zh-CN');
      break;
    case 'fr':
      resource = await import('@/localization/fr');
      break;
    case 'ru':
      resource = await import('@/localization/ru');
      break;
    case 'tr':
      resource = await import('@/localization/tr');
      break;
    case 'vi':
      resource = await import('@/localization/vi');
      break;
    default:
      resource = await import('@/localization/en');
  }
  return {
    title: resource.default.common[`${kind}-title`],
    body: resource.default.common[`${kind}-body`],
  };
}
