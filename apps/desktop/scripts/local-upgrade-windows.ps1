# Private native operations for the local upgrade worker. No operation force-terminates a process.
param(
  [Parameter(Mandatory=$true)][ValidateSet('prepare','fence','inspect','stop','register','unregister','independent','notify','restore-registration')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$InputFile,
  [Parameter(Mandatory=$true)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
$inputValue = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Assert-PlainPath([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:\\' -or $Path -match '[\x00-\x1f]') { throw 'path' }
  $drive = [IO.Path]::GetPathRoot($Path).TrimEnd('\')
  $volume = @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $drive })
  if ($volume.Count -ne 1 -or $volume[0].DriveType -ne 3) { throw 'fixed-drive' }
  $cursor = $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'linked-path' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function Assert-Private([string]$Path) {
  Assert-PlainPath $Path
  $acl = Get-Acl -LiteralPath $Path
  if ($acl.Owner -ne $currentSid) {
    $owner = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($owner -ne $currentSid) { throw 'owner' }
  }
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and $sid -ne $currentSid -and $sid -ne 'S-1-5-18') { throw 'private-acl' }
  }
}
function Set-PrivateDirectory([string]$Path) {
  Assert-PlainPath $Path
  if (Test-Path -LiteralPath $Path) { Assert-Private $Path; return }
  New-Item -ItemType Directory -Path $Path | Out-Null
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetSecurityDescriptorSddlForm("O:${currentSid}G:${currentSid}D:P(A;OICI;FA;;;${currentSid})(A;OICI;FA;;;SY)")
  Set-Acl -LiteralPath $Path -AclObject $acl
  Assert-Private $Path
}
function Assert-RegisteredTarget($Value, [bool]$IgnoreVersion = $false) {
  if ([string]$Value.uninstallKey -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'uninstall-key' }
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + [string]$Value.uninstallKey
  $registration = Get-ItemProperty -LiteralPath $key
  $expected = [IO.Path]::GetDirectoryName([string]$Value.executable)
  $privateKey = 'HKCU:\Software\' + [string]$Value.uninstallKey
  $privateRegistration = Get-ItemProperty -LiteralPath $privateKey
  if ([IO.Path]::GetFullPath([string]$privateRegistration.InstallLocation).TrimEnd('\') -ne $expected) { throw 'private-install-location-differ' }
  foreach ($machineKey in @(('HKLM:\Software\' + [string]$Value.uninstallKey),
      ('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + [string]$Value.uninstallKey))) {
    if (Test-Path -LiteralPath $machineKey) { throw 'per-machine-installation-conflict' }
  }
  if ([IO.Path]::GetFullPath([string]$registration.InstallLocation).TrimEnd('\') -ne $expected -or
      [string]$registration.DisplayName -notin @('DeepSeek Harness', ('DeepSeek Harness ' + [string]$registration.DisplayVersion)) -or
      [string]$registration.UninstallString -notmatch '/currentuser') { throw 'registered-target-differ' }
  if (-not $IgnoreVersion -and $Value.version -and [string]$registration.DisplayVersion -ne [string]$Value.version) { throw 'registered-version-differ' }
}
function Task-Service {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  return $service
}
function Assert-TaskName([string]$Name) {
  if ($Name -notmatch '^DSHLocalUpgrade-[a-f0-9-]{36}$') { throw 'task-name' }
}
function Inspect-Application([string]$Executable) {
  Assert-PlainPath $Executable
  $items = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Executable })
  $processes = @($items | ForEach-Object {
    $process = Get-Process -Id $_.ProcessId
    [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;executable=$Executable;created=$process.StartTime.ToFileTimeUtc().ToString()}
  })
  $ids = @($processes | ForEach-Object { $_.pid })
  $roots = @($processes | Where-Object { $_.parent -notin $ids })
  $hostEntry = '(?:[\\/]apps[\\/]desktop-host|[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-desktop-host)[\\/]lib[\\/]index\.js(?:"|\s|$)'
  $hosts = @($items | Where-Object { $_.CommandLine -match $hostEntry } | ForEach-Object { [int]$_.ProcessId })
  $ports = @()
  if ($hosts.Count -gt 0) {
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
      $_.OwningProcess -in $hosts -and $_.LocalAddress -eq '127.0.0.1'
    } | ForEach-Object { [int]$_.LocalPort } | Select-Object -Unique)
  }
  $responsive = $false
  if ($roots.Count -eq 1) { $responsive = [DshLocalUpgradeNative]::ResponsiveWindow($roots[0].pid) }
  return @{processes=$processes;roots=@($roots | ForEach-Object { $_.pid });hosts=$hosts;ports=$ports;responsive=$responsive}
}
try {
  if ($Operation -in @('inspect','stop')) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshLocalUpgradeNative {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME time; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmRegisterResources(uint session, uint files, IntPtr names, uint apps, UniqueProcess[] processes, uint services, IntPtr servicesNames);
  [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint session, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  delegate bool EnumProc(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
  public static bool ResponsiveWindow(int pid) {
    bool found = false;
    EnumWindows(delegate(IntPtr window, IntPtr unused) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == pid && IsWindowVisible(window)) { UIntPtr result; found = SendMessageTimeout(window, 0, UIntPtr.Zero, IntPtr.Zero, 2, 1000, out result) != IntPtr.Zero; if (found) return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int GracefulShutdown(int pid, long created) {
    uint session; int code = RmStartSession(out session, 0, new StringBuilder(33));
    if (code != 0) return code;
    try {
      UniqueProcess process = new UniqueProcess(); process.pid = (uint)pid;
      process.time.dwLowDateTime = (int)(created & 0xffffffff); process.time.dwHighDateTime = (int)(created >> 32);
      code = RmRegisterResources(session, 0, IntPtr.Zero, 1, new UniqueProcess[] { process }, 0, IntPtr.Zero);
      if (code != 0) return code;
      return RmShutdown(session, 0, IntPtr.Zero);
    } finally { RmEndSession(session); }
  }
}
'@
  }
  $result = switch ($Operation) {
    'prepare' {
      Assert-Private ([string]$inputValue.consentFile)
      Assert-RegisteredTarget $inputValue
      foreach ($path in $inputValue.paths) { Assert-PlainPath ([string]$path) }
      Set-PrivateDirectory ([string]$inputValue.workRoot)
      Set-PrivateDirectory ([string]$inputValue.run)
      @{prepared=$true}
    }
    'fence' {
      Assert-RegisteredTarget $inputValue
      foreach ($path in $inputValue.paths) { Assert-PlainPath ([string]$path) }
      Assert-Private ([string]$inputValue.run)
      $drive = [IO.Path]::GetPathRoot([string]$inputValue.run).TrimEnd('\')
      $volume = @(Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $drive })
      @{fenced=$true;freeBytes=[string]$volume[0].FreeSpace}
    }
    'inspect' { Inspect-Application ([string]$inputValue.executable) }
    'stop' {
      Assert-PlainPath ([string]$inputValue.executable)
      $process = Get-Process -Id $inputValue.pid
      if ($process.Path -ne $inputValue.executable -or $process.StartTime.ToFileTimeUtc().ToString() -ne $inputValue.created) { throw 'process-changed' }
      $code = [DshLocalUpgradeNative]::GracefulShutdown([int]$inputValue.pid, [long]$inputValue.created)
      if ($code -ne 0) { throw 'graceful-shutdown-refused' }
      @{stopped=$true}
    }
    'independent' {
      $worker = Get-Process -Id $inputValue.pid
      Assert-PlainPath ([string]$inputValue.executable)
      if ($worker.Path -ne [string]$inputValue.executable -or
          ($inputValue.created -and $worker.StartTime.ToFileTimeUtc().ToString() -ne [string]$inputValue.created)) { throw 'worker-identity-changed' }
      $cursor = [int]$inputValue.pid
      $visited = @{}
      while ($cursor -gt 0) {
        if ($cursor -in $inputValue.forbidden -or $visited.ContainsKey($cursor)) { throw 'not-independent' }
        $visited[$cursor] = $true
        $item = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor"
        if ($null -eq $item) { break }
        $cursor = [int]$item.ParentProcessId
      }
      @{independent=$true;created=$worker.StartTime.ToFileTimeUtc().ToString()}
    }
    'register' {
      Assert-TaskName ([string]$inputValue.task)
      Assert-Private ([string]$inputValue.run)
      Assert-Private ([string]$inputValue.node)
      Assert-Private ([string]$inputValue.worker)
      $service = Task-Service
      $definition = $service.NewTask(0)
      $definition.RegistrationInfo.Description = 'One consented personal Desktop upgrade; no elevated privileges or credentials.'
      $definition.Principal.UserId = $currentSid
      $definition.Principal.LogonType = 3
      $definition.Principal.RunLevel = 0
      $definition.Settings.Enabled = $true
      $definition.Settings.AllowDemandStart = $true
      $definition.Settings.DisallowStartIfOnBatteries = $false
      $definition.Settings.StopIfGoingOnBatteries = $false
      # Worker deadlines report uncertain outcomes; Task Scheduler must never terminate installer or application descendants.
      $definition.Settings.ExecutionTimeLimit = 'PT0S'
      $definition.Settings.AllowHardTerminate = $false
      $action = $definition.Actions.Create(0)
      $action.Path = [string]$inputValue.node
      $action.Arguments = '"' + [string]$inputValue.worker + '" "' + [string]$inputValue.plan + '"'
      $action.WorkingDirectory = [string]$inputValue.run
      $folder = $service.GetFolder('\')
      $registered = $folder.RegisterTaskDefinition([string]$inputValue.task, $definition, 2, $currentSid, $null, 3,
        "D:P(A;;FA;;;${currentSid})(A;;FA;;;SY)")
      $registered.Run($null) | Out-Null
      @{registered=$true}
    }
    'unregister' {
      Assert-TaskName ([string]$inputValue.task)
      $service = Task-Service
      $service.GetFolder('\').DeleteTask([string]$inputValue.task, 0)
      @{removed=$true}
    }
    'restore-registration' {
      Assert-RegisteredTarget $inputValue $true
      $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + [string]$inputValue.uninstallKey
      $registration = Get-ItemProperty -LiteralPath $key
      if ([string]$registration.DisplayVersion -notin @([string]$inputValue.version, [string]$inputValue.successorVersion)) { throw 'registration-owner-changed' }
      if ([string]$registration.DisplayName -eq ('DeepSeek Harness ' + [string]$registration.DisplayVersion)) {
        Set-ItemProperty -LiteralPath $key -Name DisplayName -Value ('DeepSeek Harness ' + [string]$inputValue.version)
      }
      Set-ItemProperty -LiteralPath $key -Name DisplayVersion -Value ([string]$inputValue.version)
      @{restored=$true}
    }
    'notify' {
      $shell = New-Object -ComObject WScript.Shell
      $summary = 'Local Desktop upgrade stopped. No forced shutdown or user-data rollback was attempted. Inspect: '
      $icon = 48
      if ($inputValue.success -eq $true) { $summary = 'Local Desktop upgrade completed. Verification and retained backups: '; $icon = 64 }
      $shell.Popup($summary + [string]$inputValue.run, 15, 'DeepSeek Harness', $icon) | Out-Null
      @{notified=$true}
    }
  }
  @{ok=$true;result=$result} | ConvertTo-Json -Depth 12 -Compress | Set-Content -LiteralPath $OutputFile -Encoding UTF8
} catch {
  @{ok=$false;code="native-$Operation-failed"} | ConvertTo-Json -Compress | Set-Content -LiteralPath $OutputFile -Encoding UTF8
  exit 1
}
