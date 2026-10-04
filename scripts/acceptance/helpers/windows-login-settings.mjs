import { execFileSync } from 'node:child_process';

// Restore only this application's values; unrelated startup entries are never written.
const script = `
$ErrorActionPreference = 'Stop'
$names = @('Antigravity Manager', 'antigravity-manager', 'com.draculabo.antigravity-manager')
$keys = @('Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run')
if ($env:AGM_TEST_LOGIN_ACTION -eq 'snapshot') {
  $items = foreach ($subkey in $keys) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($subkey)
    try {
      foreach ($name in $names) {
        $present = $null -ne $key -and $key.GetValueNames() -contains $name
        $kind = $null
        $data = $null
        if ($present) {
          $kind = [int]$key.GetValueKind($name)
          $data = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          if ($kind -eq 3) { $data = [Convert]::ToBase64String($data) }
        }
        [pscustomobject]@{ subkey=$subkey; name=$name; present=$present; kind=$kind; data=$data }
      }
    } finally { if ($null -ne $key) { $key.Dispose() } }
  }
  ConvertTo-Json -InputObject @($items) -Depth 4 -Compress
} else {
  $items = Get-Content -LiteralPath $env:AGM_TEST_LOGIN_BACKUP -Raw | ConvertFrom-Json
  foreach ($item in $items) {
    if ($keys -notcontains $item.subkey -or $names -notcontains $item.name) { throw 'Invalid login settings backup' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($item.subkey, $true)
    try {
      if ($item.present) {
        if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($item.subkey) }
        $data = $item.data
        if ($item.kind -eq 3) { $data = [Convert]::FromBase64String($data) }
        $key.SetValue($item.name, $data, [Microsoft.Win32.RegistryValueKind]$item.kind)
      } elseif ($null -ne $key) { $key.DeleteValue($item.name, $false) }
    } finally { if ($null -ne $key) { $key.Dispose() } }
  }
}
`;

export function loginSettings(action, backup) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, AGM_TEST_LOGIN_ACTION: action, AGM_TEST_LOGIN_BACKUP: backup },
  }).trim();
}
