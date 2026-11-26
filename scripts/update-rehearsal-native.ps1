param(
  [Parameter(Mandatory)][ValidateSet('Installer', 'CloseApplication', 'Identity')][string]$Mode,
  [Parameter(Mandatory)][string]$Executable,
  [Parameter(Mandatory)][string]$Evidence,
  [int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
  throw 'Native rehearsal controls are restricted to disposable GitHub-hosted Windows runners'
}
$expected = [IO.Path]::GetFullPath($Executable)
$evidenceRoot = [IO.Path]::GetFullPath($Evidence)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class RehearsalWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
function OwnedProcesses {
  # Exact executable path, never an image name, title substring, or shared PID.
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $expected })
}
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$observed = $false
$actions = [Collections.Generic.List[object]]::new()
$clickedAt = [DateTime]::MinValue
while ([DateTime]::UtcNow -lt $deadline) {
  $owned = @(OwnedProcesses)
  if ($owned.Count -gt 0) { $observed = $true }
  if ($Mode -eq 'Identity' -and $owned.Count -gt 0) {
    $version = (Get-Item -LiteralPath $expected).VersionInfo.ProductVersion
    @{ executable = $expected; productVersion = $version; pids = @($owned.ProcessId) } | ConvertTo-Json -Depth 5
    exit 0
  }
  if ($observed -and $owned.Count -eq 0 -and $Mode -ne 'Identity') {
    $actions | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot "native-$Mode.json")
    exit 0
  }
  foreach ($item in $owned) {
    $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
    if (!$process -or $process.MainWindowHandle -eq 0) { continue }
    if ($Mode -eq 'CloseApplication') {
      [void][RehearsalWindow]::PostMessage($process.MainWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
      $actions.Add(@{ pid = $process.Id; action = 'WM_CLOSE'; executable = $expected })
    } elseif ($Mode -eq 'Installer') {
      $button = [RehearsalWindow]::GetDlgItem($process.MainWindowHandle, 1) # NSIS IDOK / primary wizard action
      if ($button -ne 0 -and [RehearsalWindow]::IsWindowVisible($button) -and [RehearsalWindow]::IsWindowEnabled($button) -and ([DateTime]::UtcNow - $clickedAt).TotalMilliseconds -gt 900) {
        $text = [Text.StringBuilder]::new(256)
        [void][RehearsalWindow]::GetWindowText($button, $text, 256)
        # Refuse error/message-box OK, Cancel, Back, or arbitrary app controls.
        if ($text.ToString().Replace('&', '').Trim() -match '^(Next\s*>?|Install|Finish|Close)$') {
          $actions.Add(@{ pid = $process.Id; action = $text.ToString(); executable = $expected })
          [void][RehearsalWindow]::SendMessage($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) # BM_CLICK
          $clickedAt = [DateTime]::UtcNow
        }
      }
    }
  }
  Start-Sleep -Milliseconds 300
}
$actions | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $evidenceRoot "native-$Mode.json")
throw "Timed out waiting for scoped $Mode process: $expected (observed=$observed)"
