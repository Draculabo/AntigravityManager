import path from 'path';

export type InstallNoticeLanguage = 'zh-CN' | 'en' | 'ru' | 'vi';

const installNoticeText: Record<
  InstallNoticeLanguage,
  {
    title: string;
    message: string;
    detailPrefix: string;
    buttons: [string, string];
  }
> = {
  'zh-CN': {
    title: '建议从开始菜单启动',
    message:
      '检测到你正在从非安装路径启动应用。为了确保自动更新生效，请从开始菜单或桌面快捷方式启动。如果没有快捷方式，请重新运行安装包。',
    detailPrefix: '安装目录：',
    buttons: ['打开安装目录', '知道了'],
  },
  en: {
    title: 'Please launch from the Start menu',
    message:
      'We detected the app is running from a non-install location. To ensure auto-updates work, launch it from the Start menu or desktop shortcut. If no shortcut exists, run the installer again.',
    detailPrefix: 'Install location: ',
    buttons: ['Open install folder', 'OK'],
  },
  ru: {
    title: 'Запускайте приложение из меню «Пуск»',
    message:
      'Обнаружен запуск из неустановленного пути. Чтобы автообновления работали, запускайте приложение из меню «Пуск» или ярлыка. Если ярлыка нет, запустите установщик ещё раз.',
    detailPrefix: 'Папка установки: ',
    buttons: ['Открыть папку', 'Понятно'],
  },
  vi: {
    title: 'Hãy mở ứng dụng từ menu Start',
    message:
      'Ứng dụng đang được chạy từ vị trí không phải thư mục cài đặt. Để tự động cập nhật hoạt động đúng, hãy mở ứng dụng từ menu Start hoặc biểu tượng ngoài màn hình. Nếu chưa có lối tắt, hãy chạy lại bộ cài.',
    detailPrefix: 'Thư mục cài đặt: ',
    buttons: ['Mở thư mục cài đặt', 'Đã hiểu'],
  },
};

export function resolveInstallNoticeLanguage({
  configLanguage,
  locale,
}: {
  configLanguage?: string | null;
  locale?: string | null;
}): InstallNoticeLanguage {
  const rawLanguage = configLanguage || locale;
  if (!rawLanguage) {
    return 'en';
  }

  const normalized = rawLanguage.toLowerCase();
  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }

  if (normalized.startsWith('ru')) {
    return 'ru';
  }

  if (normalized.startsWith('vi')) {
    return 'vi';
  }

  return 'en';
}

export function getInstallNoticeText(language: InstallNoticeLanguage) {
  return installNoticeText[language] || installNoticeText.en;
}

function getPathApi(platform: string) {
  if (platform === 'win32') {
    return path.win32;
  }

  return path;
}

function normalizeWindowsInstallDirName(appName: string) {
  return appName
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function getExpectedInstallRoot({
  platform,
  localAppData,
  appName,
}: {
  platform: string;
  localAppData?: string | null;
  appName: string;
}) {
  if (platform !== 'win32') {
    return null;
  }

  if (!localAppData) {
    return null;
  }

  const pathApi = getPathApi(platform);
  const installDirName = normalizeWindowsInstallDirName(appName);
  return pathApi.resolve(pathApi.join(localAppData, installDirName));
}

export function isRunningFromExpectedInstallDir({
  platform,
  isPackaged,
  localAppData,
  appName,
  execPath,
}: {
  platform: string;
  isPackaged: boolean;
  localAppData?: string | null;
  appName: string;
  execPath: string;
}) {
  if (platform !== 'win32' || !isPackaged) {
    return true;
  }

  const expectedRoot = getExpectedInstallRoot({ platform, localAppData, appName });
  if (!expectedRoot) {
    return true;
  }

  const pathApi = getPathApi(platform);
  const normalizedExecPath = pathApi.resolve(execPath);

  return normalizedExecPath.toLowerCase().startsWith(expectedRoot.toLowerCase() + pathApi.sep);
}
