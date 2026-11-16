import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listNsisAttemptLogs, readNsisAttempt } from './nsis-attempt-log.mjs';
import { installedAppWindowReady } from './nsis-app-processes.mjs';

assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 3, 'Supply the installed makensis.exe path');
const compiler = await realpath(process.argv[2]);
const project = await realpath(process.cwd());
const out = await realpath(path.join(project, 'out'));
const directory = await mkdtemp(path.join(out, 'nsis-feedback-'));
const executable = path.join(directory, 'feedback.exe');
const script = path.join(directory, 'feedback.nsi');
const include = path.join(project, 'resources', 'windows', 'nsis-feedback.nsh');
const dollar = '$';
assert.equal(
  installedAppWindowReady(directory),
  false,
  'An absent app must be reported as not ready',
);

function run(file, args, environment = process.env) {
  const result = spawnSync(file, args, {
    env: environment,
    windowsHide: true,
    timeout: 30_000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-4000));
}

await writeFile(
  script,
  String.raw`Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${executable}"
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!define VERSION "0.31.0"
Var probeMode
!define isUpdated '$probeMode == "update"'
!include "${include}"
!insertmacro MUI_PAGE_INSTFILES
${['English', 'SimpChinese', 'Russian', 'Vietnamese', 'French', 'PortugueseBR']
  .map((language) => `!insertmacro MUI_LANGUAGE "${language}"`)
  .join('\n')}
!insertmacro agmFeedbackHeader
Section
  ReadEnvStr $probeMode "AGM_FEEDBACK_FIXTURE_MODE"
  Call agmOpenInstallerLog
  ClearErrors
  !insertmacro agmStartStage "prepare-files" "Preparing"
  ${dollar}{If} ${dollar}{Errors}
    SetErrorLevel 3
    Quit
  ${dollar}{EndIf}
  SetErrors
  !insertmacro agmFinishStage "ok" ""
  ${dollar}{IfNot} ${dollar}{Errors}
    SetErrorLevel 4
    Quit
  ${dollar}{EndIf}
  ClearErrors
  ${dollar}{If} $probeMode == "failed"
    !insertmacro agmEndInstall "failed" "$\terror=fixture-failure"
  ${dollar}{Else}
    !insertmacro agmEndInstall "ok" ""
  ${dollar}{EndIf}
  ${dollar}{If} $probeMode == "fill"
    StrCpy $0 0
    ${dollar}{DoWhile} $0 < 2000
      Push "stage=fixture$\tresult=ok"
      Call agmWriteLog
      IntOp $0 $0 + 1
    ${dollar}{Loop}
  ${dollar}{EndIf}
SectionEnd
`,
);
run(compiler, ['/V2', script]);

const profile = path.join(directory, 'profile');
const logs = path.join(profile, '.antigravity-agent');
await mkdir(logs, { recursive: true });
await writeFile(path.join(logs, 'app-2026-11-15.log'), 'Application log sentinel');
await writeFile(path.join(logs, 'installer-not-owned.log'), 'Unowned installer log sentinel');
const retained = [];
for (let day = 1; day <= 7; day += 1) {
  const name = `installer-2000-01-0${day}-000000-nsi000${day}.log`;
  retained.push(name);
  await writeFile(path.join(logs, name), 'Expired fixture log');
}
for (const mode of ['silent', 'update', 'failed']) {
  const before = await listNsisAttemptLogs(logs);
  run(executable, [], {
    ...process.env,
    USERPROFILE: profile,
    AGM_FEEDBACK_FIXTURE_MODE: mode,
  });
  await readNsisAttempt(logs, before, {
    version: '0.31.0',
    mode: mode === 'update' ? 'update' : 'silent',
    outcome: mode === 'failed' ? 'failed' : 'ok',
    stages: ['prepare-files'],
    error: mode === 'failed' ? 'fixture-failure' : undefined,
  });
}
const names = await readdir(logs);
assert.equal(names.filter((name) => /^installer-\d{4}-/.test(name)).length, 5);
assert.deepEqual(
  retained.filter((name) => names.includes(name)),
  retained.slice(-2),
);
assert.equal(
  await readFile(path.join(logs, 'app-2026-11-15.log'), 'utf8'),
  'Application log sentinel',
);
assert.equal(
  await readFile(path.join(logs, 'installer-not-owned.log'), 'utf8'),
  'Unowned installer log sentinel',
);

const boundedProfile = path.join(directory, 'bounded-profile');
await mkdir(boundedProfile);
run(executable, [], {
  ...process.env,
  USERPROFILE: boundedProfile,
  AGM_FEEDBACK_FIXTURE_MODE: 'fill',
});
const boundedDirectory = path.join(boundedProfile, '.antigravity-agent');
const boundedLogs = await listNsisAttemptLogs(boundedDirectory);
assert.equal(boundedLogs.length, 1);
const bytes = await readFile(path.join(boundedDirectory, boundedLogs[0]));
assert(bytes.length >= 60000 && bytes.length <= 64 * 1024);

const blockedProfile = path.join(directory, 'blocked-profile');
await mkdir(blockedProfile);
await writeFile(path.join(blockedProfile, '.antigravity-agent'), 'Blocked log directory');
run(executable, [], { ...process.env, USERPROFILE: blockedProfile });
assert.equal(
  await readFile(path.join(blockedProfile, '.antigravity-agent'), 'utf8'),
  'Blocked log directory',
);
await writeFile(
  path.join(directory, 'result.json'),
  `${JSON.stringify({ modes: ['silent', 'update', 'failed'], retention: true, bounded: true, unavailableLog: true }, null, 2)}\n`,
);
console.log(`Native NSIS feedback acceptance passed: ${directory}`);
