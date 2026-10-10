import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const makerRoot = path.dirname(
  require.resolve('@pengx17/electron-forge-maker-appimage/package.json'),
);
function loadCommonJs(source, directory, replacements) {
  const module = { exports: {} };
  const injectedRequire = Object.assign((name) => replacements[name] ?? require(name), {
    resolve: require.resolve,
  });
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    __dirname: directory,
    require: injectedRequire,
    process,
    console,
  });
  return module.exports;
}

test('AppImage maker forwards the requested architecture and preserves path arguments', async () => {
  const parent = await realpath(os.tmpdir());
  const directory = await mkdtemp(path.join(parent, 'agm-appimage-maker-'));
  try {
    const calls = [];
    const patches = [];
    const source = await readFile(path.join(makerRoot, 'dist/src/MakerAppimage.js'), 'utf8');
    const { default: Maker } = loadCommonJs(source, makerRoot, {
      'app-builder-lib/out/util/appBuilder': {
        executeAppBuilderAsJson: async (args) => calls.push(args),
      },
      './patch-apprun': { patchAppImage: async (...args) => patches.push(args) },
    });
    for (const arch of ['x64', 'arm64']) {
      const output = path.join(directory, arch);
      const files = await new Maker().make({
        dir: path.join(directory, 'packaged app'),
        makeDir: output,
        appName: 'Manager',
        targetArch: arch,
        targetPlatform: 'linux',
        packageJSON: { version: '1.2.3', productName: 'Manager', description: 'Fixture' },
        forgeConfig: { makers: [], packagerConfig: { executableName: 'manager' } },
      });
      const args = calls.at(-1);
      assert.equal(args[args.indexOf('--arch') + 1], arch);
      assert.deepEqual(patches.at(-1), [files[0], arch]);
    }
    const commands = [];
    const helper = loadCommonJs(
      await readFile(path.join(makerRoot, 'dist/src/patch-apprun.js'), 'utf8'),
      path.join(makerRoot, 'dist/src'),
      {
        child_process: { execFileSync: (...args) => commands.push(args) },
      },
    );
    await helper.patchAppImage('/tmp/a directory/Manager.AppImage', 'arm64');
    assert.equal(commands[0][0], 'bash');
    assert.deepEqual(Array.from(commands[0][1]), [
      path.join(makerRoot, 'scripts/patch-apprun.sh'),
      '/tmp/a directory/Manager.AppImage',
      'arm64',
    ]);
  } finally {
    assert.equal(path.dirname(await realpath(directory)), parent);
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [arch, toolArch] of [
  ['x64', 'x86_64'],
  ['arm64', 'aarch64'],
]) {
  test(
    `AppImage ${arch} repacking runs without FUSE and preserves its payload`,
    {
      skip: process.platform !== 'linux',
    },
    async () => {
      const parent = await realpath(os.tmpdir());
      const directory = await mkdtemp(path.join(parent, 'agm-appimage-repack-'));
      try {
        const bin = path.join(directory, 'bin');
        const temporary = path.join(directory, 'temporary');
        await Promise.all([mkdir(bin), mkdir(temporary)]);
        const input = path.join(directory, 'Manager with spaces.AppImage');
        await writeFile(
          input,
          `#!/usr/bin/env bash
set -eu
test "$1" = --appimage-extract
mkdir squashfs-root
printf '#!/usr/bin/env bash\\nexport EXISTING=retained\\nprintf payload\\n' > squashfs-root/AppRun
`,
          { mode: 0o755 },
        );
        await writeFile(
          path.join(bin, 'wget'),
          `#!/usr/bin/env bash
set -eu
test "$1" = -c
test "$2" = "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-$EXPECTED_TOOL_ARCH.AppImage"
test "$3" = -O
cat > "$4" <<'TOOL'
#!/usr/bin/env bash
set -eu
if [ "$1" != --appimage-extract-and-run ]; then
  echo 'dlopen(): error loading libfuse.so.2' >&2
  exit 1
fi
test "$ARCH" = "$EXPECTED_TOOL_ARCH"
test "$2" = ./squashfs-root/
test "$3" = "$EXPECTED_OUTPUT"
grep -qx 'export EXISTING=retained' "$2/AppRun"
grep -qx 'export ELECTRON_OZONE_PLATFORM_HINT=auto' "$2/AppRun"
cp "$2/AppRun" "$3"
TOOL
`,
          { mode: 0o755 },
        );
        const result = spawnSync(
          'bash',
          [path.join(makerRoot, 'scripts/patch-apprun.sh'), input, arch],
          {
            env: {
              ...process.env,
              PATH: `${bin}${path.delimiter}${process.env.PATH}`,
              TMPDIR: temporary,
              EXPECTED_TOOL_ARCH: toolArch,
              EXPECTED_OUTPUT: input,
            },
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 64 * 1024,
          },
        );
        assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
        assert.equal(
          await readFile(input, 'utf8'),
          '#!/usr/bin/env bash\nexport EXISTING=retained\nexport ELECTRON_OZONE_PLATFORM_HINT=auto\nprintf payload\n',
        );
      } finally {
        assert.equal(path.dirname(await realpath(directory)), parent);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
