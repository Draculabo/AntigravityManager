const { readFileSync } = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const arch = process.env.AGM_NSIS_ARCH;

if (arch !== 'x64' && arch !== 'arm64') {
  throw new Error('AGM_NSIS_ARCH must be x64 or arm64');
}

const builderDirectory = path.dirname(require.resolve('electron-builder/package.json'));
const templateDirectory = path.dirname(
  require.resolve('app-builder-lib/package.json', { paths: [builderDirectory] }),
);
const installSection = readFileSync(
  path.join(templateDirectory, 'templates', 'nsis', 'installSection.nsh'),
  'utf8',
);
if (!installSection.includes('!insertmacro agmInstallApplication')) {
  throw new Error(
    'The app-builder-lib NSIS upgrade patch is required. Reinstall locked dependencies.',
  );
}

module.exports = {
  appId: 'com.draculabo.antigravitymanager',
  productName: 'Antigravity Manager',
  directories: {
    output: process.env.AGM_NSIS_OUTPUT || `out/make/nsis/${arch}`,
  },
  win: {
    target: 'nsis',
    executableName: 'antigravity-manager',
    icon: 'images/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    // The installer checks the ZIP extractor's result before replacing the old directory.
    useZip: true,
    differentialPackage: false,
    include: 'resources/windows/nsis-install.nsh',
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    installerLanguages: ['en_US', 'zh_CN', 'ru_RU', 'vi_VN', 'fr_FR', 'pt_BR'],
    artifactName: `Antigravity.Manager-${'${version}'}-windows-${arch}-nsis.exe`,
  },
  publish: [
    {
      provider: 'generic',
      url: `https://raw.githubusercontent.com/Draculabo/AntigravityManager/release-updates/nsis/win32/${arch}`,
    },
  ],
};
