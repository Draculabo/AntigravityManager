// Runs only isolated native fixtures. This is separate from Vitest's no-app-launch guard.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wsl = process.argv.includes('--wsl-interop');
const windows = process.platform === 'win32';
const fixtureBase = wsl ? repo : fs.realpathSync.native(os.tmpdir());
const root = fs.mkdtempSync(path.join(fixtureBase, 'agm-launch-fixture-'));
assert(
  path.resolve(root).startsWith(path.resolve(fixtureBase) + path.sep),
  'Fixture cleanup must remain inside its owning directory',
);
const windowsPath = (value) =>
  value
    .replace(/^\/mnt\/([a-z])\//, (_, drive) => `${drive.toUpperCase()}:\\`)
    .replace(/\//g, '\\');
const executable = path.join(
  root,
  windows
    ? 'Antigravity IDE.exe'
    : wsl
      ? `AntigravityLaunchFixture-${path.basename(root).slice(-6)}.exe`
      : 'antigravity',
);
const capture = path.join(root, 'argv.bin');
const dataDir = path.join(root, 'data with spaces and 中文');
fs.mkdirSync(dataDir);
let context;
let stop;

function compileModule(source, name) {
  let code = ts.transpileModule(fs.readFileSync(path.join(repo, source), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  for (const [original, replacement] of Object.entries({
    '@/shared/platform/paths': './fixture-paths.cjs',
    '@/shared/platform/nativeProcessQuery': './fixture-native-query.cjs',
    '@/shared/platform/antigravityAppTarget': './target.cjs',
    '@/shared/logging/logger': './fixture-logger.cjs',
    '@/shared/errors/appError': './app-error.cjs',
  })) {
    code = code.replaceAll(JSON.stringify(original), JSON.stringify(replacement));
  }
  code = code.replace(/require\("\.\/([A-Za-z]+)"\)/g, 'require("./$1.cjs")');
  fs.writeFileSync(
    path.join(root, `${name}.cjs`),
    `module.paths.push(${JSON.stringify(path.join(repo, 'node_modules'))});\n${code}`,
  );
}

try {
  if (process.platform !== 'linux' && !windows) {
    throw new Error(
      'Run this check with Windows or Linux Node.js, optionally using --wsl-interop.',
    );
  }
  if (windows) {
    fs.copyFileSync(process.execPath, executable);
    fs.writeFileSync(
      path.join(root, 'fixture.cjs'),
      `const fs=require('node:fs');
const {spawn}=require('node:child_process');
const args=process.argv.slice(1);
setTimeout(()=>process.exit(),60000);
if(args.includes('--fixture-worker')){
  process.send({pid:process.pid});
}else if(args.includes('--fixture-host')){
  const children=Array.from({length:7},(_,index)=>spawn(process.execPath,
    [__filename,'--fixture-worker',...(index%3===0?['--node-ipc','--clientProcessId='+process.pid]:
      index%3===1?['--useNodeIpc']:[])],
    {stdio:['ignore','ignore','ignore','ipc']}));
  Promise.all(children.map(child=>new Promise(resolve=>child.once('message',resolve))))
    .then(rows=>process.send({pid:process.pid,children:rows.map(row=>row.pid)}));
}else{
  const output=args[args.indexOf('--fixture-output')+1];
  const host=spawn(process.execPath,[__filename,'--fixture-host','--type=utility'],
    {stdio:['ignore','ignore','ignore','ipc']});
  host.once('message',row=>{
      fs.appendFileSync(output+'.count','launch\\n');
      fs.writeFileSync(output+'.pids',JSON.stringify([process.pid,row.pid,...row.children]));
      fs.writeFileSync(output, args.join('\\0'));
    });
}`,
    );
  } else if (wsl) {
    const source = path.join(root, 'fixture.cs');
    fs.writeFileSync(
      source,
      `using System; using System.IO; using System.Text; using System.Threading;
class Fixture { static void Main(string[] args) {
  int index = Array.IndexOf(args, "--fixture-output");
  if (index < 0 || index + 1 >= args.Length) return;
  File.WriteAllBytes(args[index + 1], Encoding.UTF8.GetBytes(String.Join("\\0", args)));
  File.AppendAllText(args[index + 1] + ".count", "launch\\n");
  Thread.Sleep(20000);
} }`,
    );
    execFileSync(
      '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ['/nologo', `/out:${windowsPath(executable)}`, windowsPath(source)],
      { timeout: 15000, stdio: 'pipe' },
    );
  } else {
    const source = `#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\nint main(int argc,char**argv){
      for(int i=1;i+1<argc;i++){if(strcmp(argv[i],"--fixture-output")==0){
        FILE*f=fopen(argv[i+1],"wb"); for(int j=1;j<argc;j++){fwrite(argv[j],1,strlen(argv[j]),f); if(j+1<argc)fputc(0,f);} fclose(f);
        char count[4096]; snprintf(count,sizeof(count),"%s.count",argv[i+1]); f=fopen(count,"a");fputs("launch\\n",f);fclose(f);
      }}sleep(20);return 0;}`;
    execFileSync('cc', ['-x', 'c', '-o', executable, '-'], {
      input: source,
      timeout: 15000,
      stdio: 'pipe',
    });
  }

  for (const name of [
    'launch',
    'launchContext',
    'operation',
    'processObserver',
    'windowsInterop',
    'processErrors',
    'runtimePlatform',
    'stop',
    'stopNativeProcessTree',
    'linuxProfileOwnership',
  ]) {
    compileModule(`src/modules/antigravity-runtime/${name}.ts`, name);
  }
  compileModule('src/shared/platform/antigravityAppTarget.ts', 'target');
  compileModule('src/shared/platform/nativeProcessQuery.ts', 'native-query');
  compileModule('src/shared/errors/appError.ts', 'app-error');
  fs.writeFileSync(
    path.join(root, 'fixture-native-query.cjs'),
    `const {readNativeProcessSnapshot}=require('./native-query.cjs');
    exports.readNativeProcessSnapshot=async timeout=>(await readNativeProcessSnapshot(timeout))
      .filter(row=>row.exe===${JSON.stringify(executable)});`,
  );
  fs.writeFileSync(
    path.join(root, 'fixture-logger.cjs'),
    'exports.logger={info(){},warn(...args){console.error(...args)},error(){}};',
  );
  // Discovery is restricted to our fixture so this runnable check cannot touch an installed app.
  fs.writeFileSync(
    path.join(root, 'fixture-paths.cjs'),
    `const identity=value=>value.replace(/\\\\/g,'/').toLowerCase();
    exports.isWsl=()=>${wsl};
    exports.getConfiguredAntigravityExecutablePath=()=>${JSON.stringify(executable)};
    exports.getAntigravityExecutablePath=()=>${JSON.stringify(executable)};
    exports.getConfiguredAntigravityArgs=()=>[];
    exports.getPortableUserDataDir=()=>null;
    exports.getAppDataDir=()=>${JSON.stringify(dataDir)};
    exports.areExecutablePathsEquivalent=(left,right)=>identity(left)===identity(right);
    exports.isTargetAntigravityProcessCandidate=p=>identity(p.executablePath)===identity(${JSON.stringify(wsl ? windowsPath(executable) : executable)});
    exports.isConfiguredTargetExecutableProcessCandidate=exports.isTargetAntigravityProcessCandidate;`,
  );

  const require = createRequire(path.join(root, 'entry.cjs'));
  const { startFromContext } = require('./launch.cjs');
  const { stopFromContext } = require('./stop.cjs');
  const { observeProcesses } = require('./processObserver.cjs');
  const { readNativeProcessSnapshot } = require('./native-query.cjs');
  stop = stopFromContext;
  const args = [
    ...(windows ? [path.join(root, 'fixture.cjs')] : []),
    '--fixture-output',
    wsl ? windowsPath(capture) : capture,
    '--user-data-dir',
    wsl ? windowsPath(dataDir) : dataDir,
    '--title=a"b',
  ];
  context = Object.freeze({
    target: windows ? 'ide' : 'classic',
    executablePath: executable,
    args,
    defaultUserDataDir: dataDir,
    pathOptions: { userDataDir: dataDir },
    processes: [],
  });
  const cycles = [];
  for (let cycle = 0; cycle < (windows ? 3 : 1); cycle++) {
    fs.rmSync(capture, { force: true });
    const started = Date.now();
    await startFromContext(context);
    const elapsed = Date.now() - started;
    assert(elapsed < 6000, `Confirmation exceeded the deadline: ${elapsed}ms`);
    const readyDeadline = Date.now() + 5000;
    while (!fs.existsSync(capture) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const expectedArgs =
      wsl || windows ? args : [...args, '--disable-gpu', '--disable-gpu-compositing'];
    assert.deepEqual(fs.readFileSync(capture, 'utf8').split('\0'), expectedArgs);
    assert.equal((await observeProcesses(context.target)).length, 1);
    const family = windows
      ? (await readNativeProcessSnapshot()).filter((row) => row.exe === executable)
      : [];
    if (windows) {
      const fixturePids = JSON.parse(fs.readFileSync(`${capture}.pids`, 'utf8'));
      assert.equal(fixturePids.length, 9);
      assert.deepEqual(family.map((row) => row.pid).sort(), fixturePids.sort());
    }
    const closing = Date.now();
    if (windows || wsl) {
      // These console fixtures have no window. Production must refuse to force their exit.
      await assert.rejects(stopFromContext(context, 2500), {
        messageKey: 'process-runtime.close-failed',
      });
      assert.equal((await observeProcesses(context.target)).length, 1);
      execFileSync(
        wsl ? '/mnt/c/Windows/System32/taskkill.exe' : 'C:/Windows/System32/taskkill.exe',
        ['/PID', String((await observeProcesses(context.target))[0].pid), '/T', '/F'],
        { timeout: 5000, stdio: 'ignore' },
      ); // Cleanup is restricted to this disposable console fixture.
    } else {
      await stopFromContext(context);
    }
    const closeMs = Date.now() - closing;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await observeProcesses(context.target)).length, 0);
    if (windows) {
      const remaining = await readNativeProcessSnapshot();
      assert.deepEqual(
        remaining.filter((row) =>
          family.some((item) => item.pid === row.pid && item.startTime === row.startTime),
        ),
        [],
      );
    }
    assert.equal(fs.readFileSync(`${capture}.count`, 'utf8'), 'launch\n'.repeat(cycle + 1));
    cycles.push({
      confirmedMs: elapsed,
      closeMs,
      childProcesses: family.length ? family.length - 1 : 0,
    });
  }
  console.log(
    JSON.stringify({
      mode: windows ? 'windows' : wsl ? 'wsl-interop' : 'linux',
      cycles,
      argumentRoundTrip: 'passed',
      launches: cycles.length,
      reopenedAfterClose: false,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      fixtureCapturedArgs: fs.existsSync(capture),
      launches: fs.existsSync(`${capture}.count`)
        ? fs.readFileSync(`${capture}.count`, 'utf8').trim().split('\n').length
        : 0,
    }),
  );
  throw error;
} finally {
  if (context && stop) {
    try {
      await stop(context);
    } catch {
      /* Reported by the failed assertion; fixture exits after 20 seconds. */
    }
  }
  if (wsl && fs.existsSync(executable)) {
    try {
      execFileSync(
        '/mnt/c/Windows/System32/taskkill.exe',
        ['/IM', path.basename(executable), '/T', '/F'],
        { timeout: 3000, stdio: 'ignore' },
      );
    } catch {
      /* A successful stop has already removed this isolated fixture process. */
    }
  }
  if (windows && fs.existsSync(executable)) {
    const require = createRequire(path.join(root, 'cleanup.cjs'));
    const { readNativeProcessSnapshot } = require('./fixture-native-query.cjs');
    for (const row of await readNativeProcessSnapshot()) {
      try {
        execFileSync('taskkill.exe', ['/PID', String(row.pid), '/T', '/F'], {
          timeout: 3000,
          stdio: 'ignore',
        });
      } catch {
        /* Another fixture tree kill may already have removed this child. */
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
