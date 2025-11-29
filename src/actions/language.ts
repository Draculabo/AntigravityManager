import type { i18n } from "i18next";

export function setAppLanguage(lang: string, i18n: i18n) {
  i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
}

export function updateAppLanguage(i18n: i18n) {
  document.documentElement.lang = i18n.language;
}
