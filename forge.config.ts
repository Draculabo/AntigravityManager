import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type {
  HookFunction,
  HookFunctionErrorCallback,
  TargetArch,
  TargetPlatform,
} from '@electron/packager';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerWix } from '@electron-forge/maker-wix';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';
import MakerAppImage from '@pengx17/electron-forge-maker-appimage';
import setLanguages from 'electron-packager-languages';
import * as fs from 'fs';
import * as path from 'path';
import { stringify as yamlStringify } from 'yaml';

const nativeModules = ['better-sqlite3', 'keytar', 'bindings', 'file-uri-to-path'];
const ResolvedMakerAppImage = MakerAppImage;
const keepLanguages = new Set(['en', 'en-US', 'zh-CN', 'ru']);
const windowsExecutableName = 'antigravity-manager';

const isStartCommand = process.argv.some((arg) => arg.includes('start'));

const artifactRegex = /.*\.(?:exe|dmg|AppImage|zip|deb|rpm|msi)$/;
const platformNamesMap: Record<string, string> = {
  darwin: 'macos',
  linux: 'linux',
  win32: 'windows',
};
const ymlBaseNameMap: Record<string, string> = {
  darwin: 'latest-mac',
  linux: 'latest-linux',
  win32: 'latest',
};
const ignorePatterns = [
  /^\/\.git/,
  /^\/\.github/,
  /^\/\.vscode/,
  /^\/\.idea/,
  /^\/openspec/,
  /^\/docs?/,
  /^\/scripts?/,
  /^\/tests?/,
  /^\/mocks?/,
  /^\/src/,
  /^\/node_modules\/\.cache/,
];
const setLanguagesHook = setLanguages([...keepLanguages.values()]);
const enableDebMakerOnLinuxEnv =
  process.env.FORGE_ENABLE_DEB_ON_LINUX === '1' || process.env.FORGE_ENABLE_DEB_ON_LINUX === 'true';
const packagerAfterCopy: HookFunction[] = [
  (
    buildPath: string,
    electronVersion: string,
    platform: TargetPlatform,
    arch: TargetArch,
    callback: HookFunctionErrorCallback,
  ) => {
    if (platform !== 'win32') {
      callback();
      return;
    }

    setLanguagesHook(buildPath, electronVersion, platform, arch, callback);
  },
];

function isDebianLikeLinux() {
  if (process.platform !== 'linux') {
    return false;
  }

  const osReleasePath = '/etc/os-release';
  if (!fs.existsSync(osReleasePath)) {
    return false;
  }

  const content = fs.readFileSync(osReleasePath, 'utf-8');
  const lowerContent = content.toLowerCase();

  if (lowerContent.includes('id=debian') || lowerContent.includes('id=ubuntu')) {
    return true;
  }

  if (lowerContent.includes('id_like=debian') || lowerContent.includes('id_like=ubuntu')) {
    return true;
  }

  return false;
}

function hasBinaryInPath(binaryName: string) {
  const result = spawnSync(binaryName, ['--version'], { stdio: 'ignore' });
  return result.status === 0;
}

function hasDebianPackagingTools() {
  return hasBinaryInPath('dpkg') && hasBinaryInPath('fakeroot');
}

function createDebMakers() {
  if (process.platform !== 'linux') {
    return [];
  }

  const debianLikeLinux = isDebianLikeLinux();
  const debianToolsAvailable = hasDebianPackagingTools();

  if (debianToolsAvailable && (debianLikeLinux || enableDebMakerOnLinuxEnv)) {
    return [new MakerDeb({})];
  }

  if (!debianToolsAvailable && (debianLikeLinux || enableDebMakerOnLinuxEnv)) {
    const suggestedCommand =
      'sudo dnf install dpkg fakeroot || sudo apt-get install dpkg-dev fakeroot';
    console.warn(
      `Skipping Deb maker because required tools are missing. Install dpkg and fakeroot, for example: "${suggestedCommand}".`,
    );
    return [];
  }

  if (!debianLikeLinux && enableDebMakerOnLinuxEnv) {
    console.warn(
      'FORGE_ENABLE_DEB_ON_LINUX is set but the current Linux distribution does not look Debian or Ubuntu based. Deb maker will remain disabled.',
    );
    return [];
  }

  if (!debianLikeLinux) {
    console.warn(
      'Skipping Deb maker because the current Linux distribution does not look Debian or Ubuntu based. To enable Deb builds, install dpkg and fakeroot and set FORGE_ENABLE_DEB_ON_LINUX=1.',
    );
  }

  return [];
}

function normalizeArtifactName(value?: string) {
  if (!value) {
    return 'app';
  }

  return value
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^a-zA-Z0-9.]/g, '')
    .replace(/\.+/g, '.');
}

function isSquirrelArtifact(artifactPath: string) {
  const fileName = path.basename(artifactPath);
  if (fileName === 'RELEASES') {
    return true;
  }

  return artifactPath.endsWith('.nupkg');
}

function mapArchName(arch: string, mapping: Record<string, string>) {
  return mapping[arch] || arch;
}

function getArtifactFileName({
  baseName,
  version,
  arch,
  extension,
}: {
  baseName: string;
  version: string;
  arch: string;
  extension: string;
}) {
  if (extension === '.rpm') {
    return `${baseName}-${version}-1.${arch}${extension}`;
  }

  if (extension === '.deb') {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  if (extension === '.AppImage') {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  if (extension === '.dmg') {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  if (extension === '.exe') {
    return `${baseName}_${version}_${arch}-setup${extension}`;
  }

  if (extension === '.msi') {
    return `${baseName}_${version}_${arch}_en-US${extension}`;
  }

  if (extension === '.zip') {
    return `${baseName}_${version}_${arch}${extension}`;
  }

  return `${baseName}_${version}_${arch}${extension}`;
}

function getUpdateYmlFileName(platform: string, arch: string) {
  const baseName = ymlBaseNameMap[platform];
  if (!baseName) {
    return null;
  }

  if (platform === 'darwin') {
    return arch === 'universal' ? `${baseName}.yml` : `${baseName}-${arch}.yml`;
  }

  if (platform === 'linux') {
    return arch === 'x64' ? `${baseName}.yml` : `${baseName}-${arch}.yml`;
  }

  if (platform === 'win32') {
    return arch === 'x64' ? `${baseName}.yml` : `${baseName}-${arch}.yml`;
  }

  return null;
}

function getChecksumArchLabel(platform: string, arch: string) {
  if (platform === 'linux') {
    return mapArchName(arch, { x64: 'amd64', arm64: 'aarch64' });
  }

  if (platform === 'darwin') {
    return mapArchName(arch, { x64: 'x64', arm64: 'arm64', universal: 'universal' });
  }

  if (platform === 'win32') {
    return mapArchName(arch, { x64: 'x64', arm64: 'arm64' });
  }

  return arch;
}

const appImageMaker = new ResolvedMakerAppImage({
  config: {
    icons: [
      {
        file: 'images/32x32.png',
        size: 32,
      },
      {
        file: 'images/64x64.png',
        size: 64,
      },
      {
        file: 'images/128x128.png',
        size: 128,
      },
      {
        file: 'images/128x128@2x.png',
        size: 256,
      },
    ],
  },
});
appImageMaker.name = '@pengx17/electron-forge-maker-appimage';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/{better-sqlite3,keytar}/**/*',
    },
    name: 'Antigravity Manager',
    executableName: windowsExecutableName,
    icon: 'images/icon', // Electron Forge automatically adds .icns/.ico
    extraResource: ['src/assets'], // Copy assets folder to resources/assets
    afterCopy: packagerAfterCopy,
    ignore: ignorePatterns,
    prune: true,
  },
  rebuildConfig: {},
  hooks: {
    preMake: async () => {
      const makeDir = path.join(process.cwd(), 'out', 'make');
      if (fs.existsSync(makeDir)) {
        fs.rmSync(makeDir, { recursive: true });
      }
    },
    packageAfterCopy: async (_config, buildPath) => {
      // Copy native modules to the packaged app
      const nodeModulesPath = path.join(buildPath, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        fs.mkdirSync(nodeModulesPath, { recursive: true });
      }

      const copyModuleRecursive = (moduleName: string) => {
        const srcPath = path.join(process.cwd(), 'node_modules', moduleName);
        const destPath = path.join(nodeModulesPath, moduleName);

        if (fs.existsSync(srcPath)) {
          fs.cpSync(srcPath, destPath, { recursive: true });
          console.log(`Copied native module: ${moduleName}`);
        } else {
          console.warn(`Native module not found: ${moduleName}`);
        }
      };

      for (const moduleName of nativeModules) {
        copyModuleRecursive(moduleName);
      }

      // Copy assets to resources folder
      const assetsSrc = path.join(process.cwd(), 'src', 'assets');
      const assetsDest = path.join(buildPath, 'resources', 'assets');

      if (fs.existsSync(assetsSrc)) {
        if (!fs.existsSync(assetsDest)) {
          fs.mkdirSync(assetsDest, { recursive: true });
        }
        fs.cpSync(assetsSrc, assetsDest, { recursive: true });
        console.log(`Copied assets from ${assetsSrc} to ${assetsDest}`);
      } else {
        console.warn(`Assets directory not found: ${assetsSrc}`);
      }
    },
    postMake: async (_config, makeResults) => {
      if (!makeResults?.length) {
        return makeResults;
      }

      const ymlByTarget = new Map<
        string,
        {
          basePath: string;
          fileName: string;
          yml: {
            version?: string;
            files: {
              url: string;
              sha512: string;
              size: number;
            }[];
            releaseDate?: string;
          };
        }
      >();
      const checksumByTarget = new Map<
        string,
        {
          basePath: string;
          fileName: string;
          lines: string[];
        }
      >();

      makeResults = makeResults.map((result) => {
        const productName = normalizeArtifactName(
          result.packageJSON.productName || result.packageJSON.name,
        );
        const platformName = platformNamesMap[result.platform] || result.platform;
        const version = result.packageJSON.version;
        const platformKey = result.platform;
        const archKey = result.arch;
        const updateFileName = getUpdateYmlFileName(platformKey, archKey);
        const updateKey = updateFileName ? `${platformKey}-${archKey}` : null;
        const checksumKey = `${platformKey}-${archKey}`;
        const checksumArchLabel = getChecksumArchLabel(platformKey, archKey);
        const checksumFileName = `sha256sums-${platformName}-${checksumArchLabel}.txt`;

        if (!checksumByTarget.has(checksumKey)) {
          checksumByTarget.set(checksumKey, {
            basePath: '',
            fileName: checksumFileName,
            lines: [],
          });
        }

        if (updateFileName && updateKey && !ymlByTarget.has(updateKey)) {
          ymlByTarget.set(updateKey, {
            basePath: '',
            fileName: updateFileName,
            yml: {
              version,
              files: [],
            },
          });
        }

        const updateState = updateKey ? ymlByTarget.get(updateKey)! : null;
        const checksumState = checksumByTarget.get(checksumKey)!;

        result.artifacts = result.artifacts
          .map((artifact) => {
            if (!artifact) {
              return null;
            }

            if (isSquirrelArtifact(artifact)) {
              return artifact;
            }

            if (!artifactRegex.test(artifact)) {
              return artifact;
            }

            if (!checksumState.basePath) {
              checksumState.basePath = path.dirname(artifact);
            }

            if (updateState && !updateState.basePath) {
              updateState.basePath = path.dirname(artifact);
            }

            const extension = path.extname(artifact);
            let archLabel = archKey;
            if (platformKey === 'linux' && extension === '.rpm') {
              archLabel = mapArchName(archKey, { x64: 'x86_64', arm64: 'aarch64' });
            } else if (platformKey === 'linux' && extension === '.deb') {
              archLabel = mapArchName(archKey, { x64: 'amd64', arm64: 'arm64' });
            } else if (platformKey === 'linux' && extension === '.AppImage') {
              archLabel = mapArchName(archKey, { x64: 'amd64', arm64: 'aarch64' });
            } else if (platformKey === 'darwin') {
              archLabel = mapArchName(archKey, {
                x64: 'x64',
                arm64: 'arm64',
                universal: 'universal',
              });
            } else if (platformKey === 'win32') {
              archLabel = mapArchName(archKey, { x64: 'x64', arm64: 'arm64' });
            }

            const newArtifact = `${path.dirname(artifact)}/${getArtifactFileName({
              baseName: productName,
              version,
              arch: archLabel,
              extension,
            })}`;
            if (newArtifact !== artifact) {
              fs.renameSync(artifact, newArtifact);
            }

            try {
              const fileData = fs.readFileSync(newArtifact);
              const hash = crypto.createHash('sha512').update(fileData).digest('base64');
              const sha256 = crypto.createHash('sha256').update(fileData).digest('hex');
              const { size } = fs.statSync(newArtifact);

              if (updateState) {
                updateState.yml.files.push({
                  url: path.basename(newArtifact),
                  sha512: hash,
                  size,
                });
              }

              checksumState.lines.push(`${sha256}  ${path.basename(newArtifact)}`);
            } catch {
              console.error(`Failed to hash ${newArtifact}`);
            }

            return newArtifact;
          })
          .filter((artifact) => artifact !== null);

        return result;
      });

      const releaseDate = new Date().toISOString();
      for (const [updateKey, updateState] of ymlByTarget.entries()) {
        if (!updateState.basePath) {
          continue;
        }

        updateState.yml.releaseDate = releaseDate;
        const ymlPath = path.join(updateState.basePath, updateState.fileName);
        fs.writeFileSync(ymlPath, yamlStringify(updateState.yml));

        const [platform, arch] = updateKey.split('-');
        const sampleResult = makeResults.find(
          (result) => result.platform === platform && result.arch === arch,
        );
        if (!sampleResult) {
          continue;
        }

        makeResults.push({
          artifacts: [ymlPath],
          platform: sampleResult.platform,
          arch: sampleResult.arch,
          packageJSON: sampleResult.packageJSON,
        });
      }

      for (const [checksumKey, checksumState] of checksumByTarget.entries()) {
        if (!checksumState.basePath || checksumState.lines.length === 0) {
          continue;
        }

        const checksumPath = path.join(checksumState.basePath, checksumState.fileName);
        fs.writeFileSync(checksumPath, `${checksumState.lines.join('\n')}\n`);

        const [platform, arch] = checksumKey.split('-');
        const sampleResult = makeResults.find(
          (result) => result.platform === platform && result.arch === arch,
        );
        if (!sampleResult) {
          continue;
        }

        makeResults.push({
          artifacts: [checksumPath],
          platform: sampleResult.platform,
          arch: sampleResult.arch,
          packageJSON: sampleResult.packageJSON,
        });
      }

      return makeResults;
    },
  },
  makers: [
    new MakerSquirrel({
      setupIcon: 'images/icon.ico',
      iconUrl:
        'https://raw.githubusercontent.com/Draculabo/AntigravityManager/main/images/icon.ico',
    }),
    ...(process.platform === 'win32' && process.arch === 'x64'
      ? [
          new MakerWix({
            language: 1033,
            icon: path.join(process.cwd(), 'images', 'icon.ico'),
            exe: `${windowsExecutableName}.exe`,
            ui: { chooseDirectory: true },
          }),
        ]
      : []),
    new MakerDMG(
      {
        overwrite: true,
        icon: 'images/icon.icns',
        iconSize: 160,
      },
      ['darwin'],
    ),
    new MakerZIP({}, ['darwin']),
    appImageMaker,
    new MakerRpm({}),
    ...createDebMakers(),
  ],
  publishers: [
    {
      /*
       * Publish release on GitHub as draft.
       * Remember to manually publish it on GitHub website after verifying everything is correct.
       */
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'Draculabo',
          name: 'AntigravityManager',
        },
        draft: true,
        prerelease: false,
      },
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    ...(!isStartCommand
      ? [
          new AutoUnpackNativesPlugin({}),
          new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
          }),
        ]
      : []),
  ],
};

export default config;
