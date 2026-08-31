import path from 'path';

interface TrayIconPathOptions {
  inDevelopment: boolean;
  platform: NodeJS.Platform;
  cwd: string;
  resourcesPath: string;
}

interface TemplateImage {
  setTemplateImage(isTemplate: boolean): void;
}

export function resolveTrayIconPath({
  inDevelopment,
  platform,
  cwd,
  resourcesPath,
}: TrayIconPathOptions): string {
  const assetName = platform === 'darwin' ? 'tray.png' : 'icon.png';
  return inDevelopment
    ? path.join(cwd, 'src/assets', assetName)
    : path.join(resourcesPath, 'assets', assetName);
}

export function configureTrayIcon(icon: TemplateImage, platform: NodeJS.Platform): void {
  icon.setTemplateImage(platform === 'darwin');
}
