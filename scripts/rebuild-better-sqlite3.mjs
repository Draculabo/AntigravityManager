import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const betterSqliteDir = path.join(rootDir, 'node_modules', 'better-sqlite3');
const binDir = path.join(betterSqliteDir, 'bin');
const releaseDir = path.join(betterSqliteDir, 'build', 'Release');

const ELECTRON_VERSION = '42.11.18';
const ELECTRON_ABI = '146';
const NODE_ABI = '147';

const ELECTRON_BIN_NAME = `better_sqlite3_electron${ELECTRON_ABI}.node`;
const NODE_BIN_NAME = `better_sqlite3_node${NODE_ABI}.node`;

export function applyV8Patches() {
  if (!fs.existsSync(betterSqliteDir)) {
    return;
  }

  // 1. Patch macros.cpp for V8 >= 13 ExternalPointerTypeTagDefault
  const macrosPath = path.join(betterSqliteDir, 'src', 'util', 'macros.cpp');
  if (fs.existsSync(macrosPath)) {
    let macros = fs.readFileSync(macrosPath, 'utf8');
    if (!macros.includes('kExternalPointerTypeTagDefault')) {
      macros = macros.replace(
        /#define OnlyAddon static_cast<Addon\*>\(info\.Data\(\)\.As<v8::External>\(\)->Value\(\)\)/g,
        `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13\n#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value(v8::kExternalPointerTypeTagDefault))\n#else\n#define OnlyAddon static_cast<Addon*>(info.Data().As<v8::External>()->Value())\n#endif`,
      );
      fs.writeFileSync(macrosPath, macros, 'utf8');
    }
  }

  // 2. Patch better_sqlite3.cpp for V8 >= 13 External::New with tag
  const betterSqliteCpp = path.join(betterSqliteDir, 'src', 'better_sqlite3.cpp');
  if (fs.existsSync(betterSqliteCpp)) {
    let cpp = fs.readFileSync(betterSqliteCpp, 'utf8');
    if (!cpp.includes('kExternalPointerTypeTagDefault')) {
      cpp = cpp.replace(
        /v8::Local<v8::External> data = v8::External::New\(isolate, addon\);/g,
        `#if defined(V8_MAJOR_VERSION) && V8_MAJOR_VERSION >= 13\n\tv8::Local<v8::External> data = v8::External::New(isolate, addon, v8::kExternalPointerTypeTagDefault);\n#else\n\tv8::Local<v8::External> data = v8::External::New(isolate, addon);\n#endif`,
      );
      fs.writeFileSync(betterSqliteCpp, cpp, 'utf8');
    }
  }

  // 3. Patch helpers.cpp to use nullptr for setter in SetNativeDataProperty
  const helpersPath = path.join(betterSqliteDir, 'src', 'util', 'helpers.cpp');
  if (fs.existsSync(helpersPath)) {
    let helpers = fs.readFileSync(helpersPath, 'utf8');
    if (helpers.includes('func,\n\t\t0,\n\t\tdata')) {
      helpers = helpers.replace('func,\n\t\t0,\n\t\tdata', 'func,\n\t\tnullptr,\n\t\tdata');
      fs.writeFileSync(helpersPath, helpers, 'utf8');
    }
  }

  // 4. Patch database.js to support dual-targeting runtime load
  const databaseJsPath = path.join(betterSqliteDir, 'lib', 'database.js');
  if (fs.existsSync(databaseJsPath)) {
    let dbJs = fs.readFileSync(databaseJsPath, 'utf8');
    if (!dbJs.includes('better_sqlite3_electron146.node')) {
      const targetNeedle =
        "addon = DEFAULT_ADDON || (DEFAULT_ADDON = require('bindings')('better_sqlite3.node'));";
      const replacement = `if (!DEFAULT_ADDON) {
				const isElectron = Boolean(process.versions.electron);
				const binName = isElectron ? 'better_sqlite3_electron146.node' : 'better_sqlite3_node147.node';
				const specificBin = path.join(__dirname, '../bin', binName);
				if (fs.existsSync(specificBin)) {
					try {
						DEFAULT_ADDON = require(specificBin);
					} catch {}
				}
				if (!DEFAULT_ADDON) {
					DEFAULT_ADDON = require('bindings')('better_sqlite3.node');
				}
			}
			addon = DEFAULT_ADDON;`;
      if (dbJs.includes(targetNeedle)) {
        dbJs = dbJs.replace(targetNeedle, replacement);
        fs.writeFileSync(databaseJsPath, dbJs, 'utf8');
      }
    }
  }
}

export function buildElectron(force = false) {
  const electronBinPath = path.join(binDir, ELECTRON_BIN_NAME);
  const releaseBinPath = path.join(releaseDir, 'better_sqlite3.node');

  if (!force && fs.existsSync(electronBinPath)) {
    if (!fs.existsSync(releaseDir)) {
      fs.mkdirSync(releaseDir, { recursive: true });
    }
    fs.copyFileSync(electronBinPath, releaseBinPath);
    return;
  }

  applyV8Patches();
  fs.mkdirSync(binDir, { recursive: true });

  const nodeGypCmd = process.env.NODE_GYP || 'node-gyp';
  const rebuildCmd = `${nodeGypCmd} rebuild --target=${ELECTRON_VERSION} --arch=${process.arch} --dist-url=https://artifacts.electronjs.org/headers/dist`;
  execSync(rebuildCmd, {
    cwd: betterSqliteDir,
    stdio: 'inherit',
  });

  if (fs.existsSync(releaseBinPath)) {
    fs.copyFileSync(releaseBinPath, electronBinPath);
  }
}

export function buildNode(force = false) {
  const nodeBinPath = path.join(binDir, NODE_BIN_NAME);
  const electronBinPath = path.join(binDir, ELECTRON_BIN_NAME);
  const releaseBinPath = path.join(releaseDir, 'better_sqlite3.node');

  if (!force && fs.existsSync(nodeBinPath)) {
    return;
  }

  applyV8Patches();
  fs.mkdirSync(binDir, { recursive: true });

  const nodeGypCmd = process.env.NODE_GYP || 'node-gyp';
  const rebuildCmd = `${nodeGypCmd} rebuild`;
  execSync(rebuildCmd, {
    cwd: betterSqliteDir,
    stdio: 'inherit',
  });

  if (fs.existsSync(releaseBinPath)) {
    fs.copyFileSync(releaseBinPath, nodeBinPath);
  }

  // Restore electron binary in Release if available
  if (fs.existsSync(electronBinPath)) {
    fs.copyFileSync(electronBinPath, releaseBinPath);
  }
}

export function ensureDualBinaries(force = false) {
  applyV8Patches();
  buildNode(force);
  buildElectron(force);
}

export function ensureBetterSqliteElectron() {
  const electronBinPath = path.join(binDir, ELECTRON_BIN_NAME);
  const releaseBinPath = path.join(releaseDir, 'better_sqlite3.node');

  if (fs.existsSync(electronBinPath)) {
    if (!fs.existsSync(releaseDir)) {
      fs.mkdirSync(releaseDir, { recursive: true });
    }
    fs.copyFileSync(electronBinPath, releaseBinPath);
    return;
  }

  buildElectron(false);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');

  if (args.includes('--node')) {
    buildNode(force);
  } else if (args.includes('--all')) {
    ensureDualBinaries(force);
  } else {
    // Default to --electron
    buildElectron(force);
  }
}
