const arch = process.env.AGM_NSIS_ARCH;

if (arch !== 'x64' && arch !== 'arm64') {
  throw new Error('AGM_NSIS_ARCH must be x64 or arm64');
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
    oneClick: true,
    perMachine: false,
    artifactName: `Antigravity.Manager-${'${version}'}-windows-${arch}-nsis.exe`,
  },
  publish: [
    {
      provider: 'generic',
      url: `https://raw.githubusercontent.com/Draculabo/AntigravityManager/release-updates/nsis/win32/${arch}`,
    },
  ],
};
