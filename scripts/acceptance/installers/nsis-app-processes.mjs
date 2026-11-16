import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function fixtureProcesses(command, installRoot) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    env: { ...process.env, AGM_TEST_INSTALL_ROOT: installRoot },
    windowsHide: true,
    timeout: 15_000,
    encoding: 'utf8',
    maxBuffer: 4000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr.slice(-2000));
  return result.stdout.trim();
}

export function installedAppWindowReady(installRoot) {
  return (
    fixtureProcesses(
      '$ErrorActionPreference="Stop"; $exe=Join-Path $env:AGM_TEST_INSTALL_ROOT "antigravity-manager.exe"; Get-Process | Where-Object { $_.ProcessName -eq "antigravity-manager" -and $_.Path -eq $exe -and $_.MainWindowHandle -ne 0 -and $_.Responding } | Select-Object -First 1 -ExpandProperty Id',
      installRoot,
    ).length > 0
  );
}

export function stopFixtureApps(installRoot) {
  fixtureProcesses(
    '$root=[IO.Path]::GetFullPath($env:AGM_TEST_INSTALL_ROOT); Get-CimInstance Win32_Process -Filter "Name = \'antigravity-manager.exe\'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
    installRoot,
  );
}
