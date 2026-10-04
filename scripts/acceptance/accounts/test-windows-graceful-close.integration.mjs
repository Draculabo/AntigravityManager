// Runs production stop logic against disposable WinForms windows, never installed clients.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

assert.equal(process.platform, 'win32');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-graceful-close-'));
const exe = path.join(root, 'fixture.exe');
const source = path.join(root, 'fixture.cs');
fs.writeFileSync(
  source,
  `using System; using System.IO; using System.Windows.Forms;
class Fixture {
  [STAThread] static void Main(string[] args) {
    var form = new Form(); form.Text = "Disposable account switch fixture";
    form.Shown += (s,e) => File.WriteAllText(args[0]+".ready", "ready");
    form.FormClosing += (s,e) => {
      File.WriteAllText(args[0]+".requested", "normal close received");
      if (args[1] == "refuse") { e.Cancel = true; return; }
      File.WriteAllText(args[0]+".saved", "in-memory conversation flushed");
    };
    Application.Run(form);
  }
}`,
);
const compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
execFileSync(
  compiler,
  ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', `/out:${exe}`, source],
  { timeout: 15000, windowsHide: true, maxBuffer: 4096 },
);
const stopSource = fs.readFileSync('src/modules/antigravity-runtime/stop.ts', 'utf8');
const compiled = ts.transpileModule(stopSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const nativeRequire = createRequire(import.meta.url);
let child;
let exited;
const context = { target: 'ide', executablePath: exe, processes: [] };
const dependencies = {
  '@/shared/logging/logger': { logger: { warn() {} } },
  '@/shared/platform/paths': { isWsl: () => false },
  './processObserver': {
    getProcessProbeTimeout: () => 1000,
    observeProcesses: async () => (exited ? [] : [{ pid: child.pid }]),
  },
  './launchContext': { assertContextProcesses: () => {} },
  './processErrors': {
    processError: (reason) =>
      Object.assign(new Error(reason), { messageKey: `process-runtime.${reason}` }),
  },
  './runtimePlatform': { usesWindowsRuntime: () => true },
  './stopNativeProcessTree': { stopNativeProcessTree: () => assert.fail('Unexpected Linux path') },
};
const exported = {};
new Function('require', 'exports', compiled)(
  (name) => dependencies[name] ?? nativeRequire(name),
  exported,
);
try {
  for (const mode of ['accept', 'refuse']) {
    const marker = path.join(root, mode);
    exited = false;
    child = spawn(exe, [marker, mode], { stdio: 'ignore' });
    child.once('exit', () => {
      exited = true;
    });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(marker + '.ready') && Date.now() < deadline) {
      await delay(100);
    }
    assert(fs.existsSync(marker + '.ready'), 'Fixture window must be ready');
    if (mode === 'accept') {
      await exported.stopFromContext(context, 7000);
      assert(exited);
      assert.equal(fs.readFileSync(marker + '.saved', 'utf8'), 'in-memory conversation flushed');
    } else {
      await assert.rejects(exported.stopFromContext(context, 2500), {
        messageKey: 'process-runtime.exit-unconfirmed',
      });
      assert.equal(exited, false, 'A refused close must leave the client alive');
      assert(fs.existsSync(marker + '.requested'));
      assert.equal(fs.existsSync(marker + '.saved'), false);
      child.kill(); // Only this disposable fixture is terminated during cleanup.
      const cleanupDeadline = Date.now() + 5000;
      while (!exited && Date.now() < cleanupDeadline) {
        await delay(50);
      }
      assert(exited, 'Fixture cleanup must finish within its deadline');
    }
    console.log(JSON.stringify({ mode, result: 'passed' }));
  }
} finally {
  if (child && !exited) {
    child.kill();
    const cleanupDeadline = Date.now() + 5000;
    while (!exited && Date.now() < cleanupDeadline) {
      await delay(50);
    }
  }
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
