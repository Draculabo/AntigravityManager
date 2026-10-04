import { execFileSync } from 'node:child_process';

const registryScript = `
$ErrorActionPreference = 'Stop'
$path = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\antigravity_manager'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $true)
if ($null -eq $key) { throw 'Existing Squirrel registration is absent' }
try {
  if ($env:AGM_TEST_REGISTRY_ACTION -eq 'snapshot') {
    $items = @($key.GetValueNames() | Sort-Object | ForEach-Object {
      $name = $_
      $kind = $key.GetValueKind($name)
      $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) {
        $value = [Convert]::ToBase64String($value)
      }
      [pscustomobject]@{ name=$name; kind=[int]$kind; value=$value }
    })
    [pscustomobject]@{ items=$items } | ConvertTo-Json -Compress -Depth 5
  } elseif ($env:AGM_TEST_REGISTRY_ACTION -eq 'restore') {
    $backup = $env:AGM_TEST_REGISTRY_BACKUP | ConvertFrom-Json
    $names = @($backup.items | ForEach-Object { $_.name })
    foreach ($name in $key.GetValueNames()) {
      if ($names -notcontains $name) { $key.DeleteValue($name, $false) }
    }
    foreach ($item in $backup.items) {
      $kind = [Microsoft.Win32.RegistryValueKind]$item.kind
      $value = $item.value
      if ($kind -eq [Microsoft.Win32.RegistryValueKind]::Binary) {
        $value = [Convert]::FromBase64String($value)
      }
      $key.SetValue($item.name, $value, $kind)
    }
  } else { throw 'Invalid registry action' }
} finally { $key.Dispose() }
`;

export function squirrelRegistration(action, backup = '') {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', registryScript],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        AGM_TEST_REGISTRY_ACTION: action,
        AGM_TEST_REGISTRY_BACKUP: backup,
      },
    },
  ).trim();
}
