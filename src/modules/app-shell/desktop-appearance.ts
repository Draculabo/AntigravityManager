export const DESKTOP_LANGUAGES = ['en', 'zh-CN', 'ru', 'vi', 'tr', 'fr', 'pt-BR', 'ja'] as const;
export type DesktopLanguage = (typeof DESKTOP_LANGUAGES)[number];

export function normalizeDesktopLanguage(value: string): DesktopLanguage {
  const code = value.trim().replaceAll('_', '-').toLowerCase();
  const base = code.split('-')[0];
  return (
    DESKTOP_LANGUAGES.find((language) => language.toLowerCase().split('-')[0] === base) ?? 'en'
  );
}

export const DESKTOP_ZOOM_LEVELS = [75, 90, 100, 110, 125, 150] as const;
export type DesktopZoom = (typeof DESKTOP_ZOOM_LEVELS)[number];
export const DEFAULT_DESKTOP_ZOOM = 100;

export function isDesktopZoom(value: unknown): value is DesktopZoom {
  return DESKTOP_ZOOM_LEVELS.some((level) => level === value);
}

export type DesktopZoomCommand = 'in' | 'out' | 'reset';

export function isDesktopZoomCommand(value: unknown): value is DesktopZoomCommand {
  return value === 'in' || value === 'out' || value === 'reset';
}

export function nextDesktopZoom(current: DesktopZoom, command: DesktopZoomCommand): DesktopZoom {
  if (command === 'reset') {
    return DEFAULT_DESKTOP_ZOOM;
  }
  const nextIndex = DESKTOP_ZOOM_LEVELS.indexOf(current) + (command === 'in' ? 1 : -1);
  return DESKTOP_ZOOM_LEVELS[nextIndex] ?? current;
}
