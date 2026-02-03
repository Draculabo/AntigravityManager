import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import * as fs from 'fs';
import * as path from 'path';

const nativeModules = ['better-sqlite3', 'keytar', 'bindings', 'file-uri-to-path'];

const isStartCommand = process.argv.some((arg) => arg.includes('start'));

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/{better-sqlite3,keytar}/**/*',
    },
    name: 'Antigravity Manager',
    executableName: 'antigravity-manager',
    icon: 'images/icon', // Electron Forge automatically adds .icns/.ico
  },
  rebuildConfig: {
    // Skip rebuild for native modules during development since they are pre-compiled for arm64 Electron
    onlyModules: isStartCommand ? [] : undefined,
  },
  hooks: {
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
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      format: 'ULFO',
    }),
    new MakerRpm({}),
    new MakerDeb({}),
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
