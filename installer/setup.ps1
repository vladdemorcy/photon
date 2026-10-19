<#
  Photon setup for Windows.

  Installs (or updates, or removes) Photon:
    1. Checks for Node.js 18 or newer. If it's missing or too old, downloads the current
       LTS installer from nodejs.org, checks it against nodejs.org's SHA-256 list, and
       installs it silently to its default folder (C:\Program Files\nodejs).
    2. Copies Photon, with its packages already included, to C:\Program Files\Photon.
    3. Keeps settings in C:\ProgramData\Photon, readable only by SYSTEM and Administrators
       (they hold sign-in tokens). Optionally brings over settings from an older copy.
    4. Runs Photon as a Windows service (WinSW) that starts with Windows and restarts
       itself if it stops unexpectedly.
    5. Adds firewall rules for the local network, a Start menu entry and an entry in
       Settings > Apps so it can be removed.

  Usually started by Photon-Setup.exe. Options:
    -Quiet               install with no window, using the defaults or the options below
    -InstallDir <path>   where Photon goes (default C:\Program Files\Photon)
    -Port <number>       web page port (default 8787, or the current one when updating)
    -ImportFrom <path>   folder of an older Photon to bring settings over from
    -NoFirewall          don't add firewall rules
    -NoDesktopIcon       don't put a Photon icon on the desktop
    -Uninstall           remove Photon (add -DeleteData to also remove settings)
#>
[CmdletBinding()]
param(
  [string]$Payload = $PSScriptRoot,
  [switch]$Uninstall,
  [switch]$Quiet,
  [string]$InstallDir,
  [int]$Port = 0,
  [string]$ImportFrom,
  [switch]$NoFirewall,
  [switch]$NoDesktopIcon,
  [switch]$DeleteData,
  # For checking the design: draw one page to a PNG file and exit, without installing anything.
  [string]$PreviewPng,
  [string]$PreviewPage = 'PageWelcome'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# If anything stops setup before or while the window is up, say so and save the
# details, instead of disappearing without a word.
$StartupErrorFile = Join-Path $env:TEMP 'Photon-Setup-error.txt'
Remove-Item -LiteralPath $StartupErrorFile -Force -ErrorAction SilentlyContinue
function Show-Fatal($Err) {
  $msg = if ($Err.Exception) { $Err.Exception.Message } else { "$Err" }
  $where = if ($Err.InvocationInfo) { $Err.InvocationInfo.PositionMessage } else { '' }
  $text = "Photon setup stopped because of an error.`r`n`r`n$msg`r`n`r`n$where`r`n`r`n$($Err.ScriptStackTrace)`r`n`r`nPowerShell $($PSVersionTable.PSVersion), language mode $($ExecutionContext.SessionState.LanguageMode), $([Environment]::OSVersion.VersionString)"
  try { Set-Content -LiteralPath $StartupErrorFile -Value $text -Encoding UTF8 } catch { }
  if (-not $Quiet) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [void][System.Windows.Forms.MessageBox]::Show("Photon setup stopped because of an error:`r`n`r`n$msg`r`n`r`nThe details are saved in $StartupErrorFile", 'Photon Setup', 'OK', 'Error')
    } catch { }
  } else { Write-Output $text }
}
trap { Show-Fatal $_; exit 3 }

# ---------------------------------------------------------------------------
# Admin rights. Photon-Setup.exe already asks for them; this covers running the
# script directly.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $PreviewPng -and -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value) { $argList += "-$($kv.Key)" } }
    else { $argList += "-$($kv.Key)"; $argList += "`"$($kv.Value)`"" }
  }
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $argList -Verb RunAs
  exit 0
}

# ---------------------------------------------------------------------------
# Shared state between the window and the background worker.
$sync = [hashtable]::Synchronized(@{})
$sync.Log = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$sync.Steps = [hashtable]::Synchronized(@{})
$sync.LogFile = Join-Path $env:TEMP 'Photon-Setup.log'
$sync.Pct = -1
$sync.PctText = ''
$sync.Done = $false
$sync.Result = $null
$sync.Current = $null

# ---------------------------------------------------------------------------
# Functions used by both the window and the worker. Kept as one script block so the
# worker (which runs in its own runspace) gets an identical copy.
$Common = {
  $AppName = 'Photon'
  $ServiceId = 'Photon'
  $DataDir = Join-Path $env:ProgramData 'Photon'
  $DefaultInstallDir = Join-Path $env:ProgramFiles 'Photon'
  $UninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Photon'
  $MinNodeMajor = 18

  function Write-SetupLog([string]$Message) {
    $line = '{0:HH:mm:ss}  {1}' -f (Get-Date), $Message
    $sync.Log.Enqueue($line)
    try { Add-Content -LiteralPath $sync.LogFile -Value $line -Encoding UTF8 } catch { }
  }

  function Set-Step([string]$Id, [string]$State, [string]$Note = '') {
    $sync.Steps[$Id] = @{ State = $State; Note = $Note }
    if ($State -eq 'active') { $sync.Current = $Id }
    if ($Note) { Write-SetupLog "$Id - $State - $Note" } else { Write-SetupLog "$Id - $State" }
  }

  function Get-NodeArch {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { return 'arm64' }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') { return 'x64' }
    return 'x86'
  }

  # The newest usable node.exe on this computer, or $null.
  function Get-NodeInfo {
    $candidates = New-Object System.Collections.Generic.List[string]
    $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
    try {
      $reg = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop).InstallPath
      if ($reg) { $candidates.Add((Join-Path $reg 'node.exe')) }
    } catch { }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates.Add($cmd.Source) }
    $best = $null
    foreach ($p in ($candidates | Select-Object -Unique)) {
      if (-not (Test-Path -LiteralPath $p)) { continue }
      try { $v = (& $p -v 2>$null | Select-Object -First 1) } catch { continue }
      if ("$v".Trim() -match '^v(\d+)\.(\d+)\.(\d+)') {
        $info = [pscustomobject]@{ Path = $p; Version = "$v".Trim(); Major = [int]$Matches[1]; Number = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" }
        if (-not $best -or $info.Number -gt $best.Number) { $best = $info }
      }
    }
    # Some Node installs (version managers, package managers) put a small launcher named node.exe
    # on the PATH that starts the real one. The service must run the real one, or Windows loses
    # track of Photon and an update leaves the old copy running.
    if ($best) {
      try {
        $real = (& $best.Path -p 'process.execPath' 2>$null | Select-Object -First 1)
        if ($real -and (Test-Path -LiteralPath "$real".Trim())) { $best.Path = "$real".Trim() }
      } catch { }
    }
    return $best
  }

  function Get-Existing {
    $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    $arp = $null
    try { $arp = Get-ItemProperty -Path $UninstallKey -ErrorAction Stop } catch { }
    [pscustomobject]@{
      Installed   = [bool]($svc -or $arp)
      Running     = [bool]($svc -and $svc.Status -eq 'Running')
      InstallDir  = if ($arp -and $arp.InstallLocation) { $arp.InstallLocation } else { $null }
      Port        = if ($arp -and $arp.PhotonPort) { [int]$arp.PhotonPort } else { $null }
      Version     = if ($arp) { $arp.DisplayVersion } else { $null }
      DesktopIcon = if ($arp -and $null -ne $arp.PhotonDesktopIcon) { [bool][int]$arp.PhotonDesktopIcon } else { $true }
      HasSettings = Test-Path -LiteralPath (Join-Path $DataDir 'config.json')
    }
  }

  # What is listening on a TCP port, if anything.
  function Get-PortOwner([int]$PortNumber) {
    $c = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return $null }
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    $cmdLine = ''
    try { $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)").CommandLine } catch { }
    [pscustomobject]@{ ProcessId = $c.OwningProcess; Name = if ($proc) { $proc.ProcessName } else { 'unknown' }; CommandLine = $cmdLine }
  }

  # Photon processes left running outside the service (an older version that Windows lost
  # track of, or a copy started by hand). They hold the port and can write over settings.
  function Stop-StrayPhoton([int]$PortNumber, [string]$Dir) {
    $found = @()
    try {
      $found = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object {
        $cl = [string]$_.CommandLine
        $cl -match 'src[\\/]server\.js' -and (($Dir -and $cl -like "*$Dir*") -or $cl -match '[\\/]Photon[\\/]app[\\/]')
      })
    } catch { }
    if ($PortNumber -gt 0) {
      $owner = Get-PortOwner $PortNumber
      if ($owner -and $owner.Name -eq 'node' -and $owner.CommandLine -match 'server\.js' -and -not ($found | Where-Object { $_.ProcessId -eq $owner.ProcessId })) {
        $found += [pscustomobject]@{ ProcessId = $owner.ProcessId; CommandLine = $owner.CommandLine }
      }
    }
    foreach ($p in $found) {
      Write-SetupLog "Stopping a Photon process outside the service (process $($p.ProcessId)): $($p.CommandLine)"
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { Write-SetupLog "  couldn't stop it: $($_.Exception.Message)" }
    }
    if ($found.Count) { Start-Sleep -Milliseconds 800 }
  }

  # A folder holding Photon settings: the folder itself or its "data" subfolder.
  function Find-PhotonData([string]$Folder) {
    if (-not $Folder) { return $null }
    foreach ($c in @($Folder, (Join-Path $Folder 'data'))) {
      if (Test-Path -LiteralPath (Join-Path $c 'config.json')) { return $c }
    }
    return $null
  }

  function Get-LanAddresses {
    try {
      Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Sort-Object -Property InterfaceMetric | Select-Object -ExpandProperty IPAddress
    } catch { @() }
  }
}

# ---------------------------------------------------------------------------
# The work itself, run in a background runspace so the window stays responsive.
$InstallWork = {
  $o = $sync.Options
  $app = Join-Path $o.InstallDir 'app'
  $svcDir = Join-Path $o.InstallDir 'service'
  $svcExe = Join-Path $svcDir 'PhotonService.exe'
  $ico = Join-Path $o.InstallDir 'installer\assets\photon.ico'

  function Stop-PhotonService {
    $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Stopped') {
      Write-SetupLog 'Stopping the running Photon service'
      Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue
      try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { }
    }
    Stop-StrayPhoton $o.Port $o.InstallDir
    if ($o.OldPort -and $o.OldPort -ne $o.Port) { Stop-StrayPhoton $o.OldPort $o.InstallDir }
  }

  function Remove-PhotonService {
    $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    Stop-PhotonService
    if (Test-Path -LiteralPath $svcExe) { & $svcExe uninstall 2>&1 | ForEach-Object { Write-SetupLog "  $_" } }
    if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) { & sc.exe delete $ServiceId 2>&1 | ForEach-Object { Write-SetupLog "  $_" } }
    for ($i = 0; $i -lt 40 -and (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 500 }
  }

  function Copy-Folder([string]$From, [string]$To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    $out = & robocopy.exe $From $To /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP 2>&1
    if ($LASTEXITCODE -ge 8) { throw "Copying files to $To failed (robocopy code $LASTEXITCODE). $($out -join ' ')" }
  }

  function Save-Download([string]$Url, [string]$Dest) {
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = 'Photon-Setup'
    $req.Timeout = 30000
    $resp = $req.GetResponse()
    $total = $resp.ContentLength
    $in = $resp.GetResponseStream()
    $out = [IO.File]::Create($Dest)
    $buf = New-Object byte[] 262144
    $done = 0
    try {
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $n)
        $done += $n
        if ($total -gt 0) { $sync.Pct = [int](100 * $done / $total) }
        $sync.PctText = '{0:N1} of {1:N1} MB' -f ($done / 1MB), ($total / 1MB)
      }
    } finally { $out.Dispose(); $in.Dispose(); $resp.Dispose() }
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials } catch { }
    Write-SetupLog "Installing Photon $($o.Version) to $($o.InstallDir), port $($o.Port)"

    # 1. Node.js -------------------------------------------------------------
    Set-Step node active
    $node = Get-NodeInfo
    if ($node -and $node.Major -ge $MinNodeMajor) {
      Set-Step node done "Found Node.js $($node.Version)"
      Set-Step download skipped 'Not needed'
      Set-Step nodeinstall skipped 'Not needed'
    } else {
      if ($node) { Set-Step node done "Node.js $($node.Version) is too old, getting a newer one" } else { Set-Step node done 'Not installed yet' }

      Set-Step download active 'Finding the current LTS version'
      $arch = Get-NodeArch
      $wc = New-Object Net.WebClient
      $wc.Headers.Add('User-Agent', 'Photon-Setup')
      $index = $wc.DownloadString('https://nodejs.org/dist/index.json') | ConvertFrom-Json
      $rel = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-msi") } | Select-Object -First 1
      if (-not $rel) { throw "nodejs.org doesn't offer a Windows installer for this kind of computer ($arch)." }
      $file = "node-$($rel.version)-$arch.msi"
      $base = "https://nodejs.org/dist/$($rel.version)"
      $sums = $wc.DownloadString("$base/SHASUMS256.txt")
      $line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($file) + '\s*$') } | Select-Object -First 1
      if (-not $line) { throw "Couldn't find the checksum for $file on nodejs.org." }
      $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
      $tmp = Join-Path $env:TEMP 'Photon-Setup'
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      $msi = Join-Path $tmp $file
      Set-Step download active "Downloading Node.js $($rel.version) ($($rel.lts) LTS)"
      Save-Download "$base/$file" $msi
      $sync.Pct = -1
      $actual = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $expected) { Remove-Item -LiteralPath $msi -Force; throw "The Node.js download didn't match nodejs.org's checksum, so it wasn't used. Try again." }
      Set-Step download done "Node.js $($rel.version), checksum verified"

      Set-Step nodeinstall active 'Running the Node.js installer'
      $msiLog = Join-Path $tmp 'node-install.log'
      $p = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart', '/l*v', "`"$msiLog`"") -Wait -PassThru
      if ($p.ExitCode -eq 1618) { throw 'Another program is installing something right now. Wait for it to finish, then run Photon setup again.' }
      if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "The Node.js installer stopped with code $($p.ExitCode). Its log is at $msiLog." }
      $node = Get-NodeInfo
      if (-not $node -or $node.Major -lt $MinNodeMajor) { throw 'Node.js was installed but couldn''t be found afterwards. Restart the computer and run Photon setup again.' }
      Set-Step nodeinstall done "Installed Node.js $($node.Version)"
      Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    }

    # 2. Files ---------------------------------------------------------------
    Set-Step files active 'Copying Photon'
    Stop-PhotonService
    Copy-Folder (Join-Path $o.Payload 'app') $app
    New-Item -ItemType Directory -Force -Path $svcDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $o.Payload 'service\WinSW.NET461.exe') -Destination $svcExe -Force
    Copy-Folder (Join-Path $o.Payload 'installer') (Join-Path $o.InstallDir 'installer')
    Copy-Item -LiteralPath (Join-Path $o.Payload 'Uninstall Photon.exe') -Destination (Join-Path $o.InstallDir 'Uninstall Photon.exe') -Force
    Set-Step files done $o.InstallDir

    # 3. Settings ------------------------------------------------------------
    Set-Step settings active
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'logs') | Out-Null
    $note = 'Kept your current settings'
    if ($o.ImportFrom) {
      $src = Find-PhotonData $o.ImportFrom
      if (-not $src) { throw "No Photon settings (config.json) were found in $($o.ImportFrom)." }
      $existing = Join-Path $DataDir 'config.json'
      if (Test-Path -LiteralPath $existing) {
        $bk = Join-Path $DataDir 'backups'
        New-Item -ItemType Directory -Force -Path $bk | Out-Null
        Copy-Item -LiteralPath $existing -Destination (Join-Path $bk ('config-{0:yyyy-MM-ddTHH-mm-ss-fff}Z-before-import.json' -f (Get-Date).ToUniversalTime())) -Force
      }
      foreach ($item in 'config.json', 'players.json', 'tls', 'backups') {
        $s = Join-Path $src $item
        if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination $DataDir -Recurse -Force }
      }
      $note = "Brought over from $src"
    } elseif (-not (Test-Path -LiteralPath (Join-Path $DataDir 'config.json'))) {
      $note = 'Starting fresh'
    }
    # Only SYSTEM (the service) and Administrators can read settings: they hold sign-in tokens.
    # Lock the folder itself, then have everything inside simply inherit from it. (Earlier versions
    # applied the folder rule to each file with /T, which left existing files with no usable
    # permissions at all, so Photon could no longer read its own settings. This also repairs that.)
    $own = & takeown.exe /F $DataDir /R /A /D Y 2>&1
    if ($LASTEXITCODE -ne 0) { Write-SetupLog "  takeown: $($own -join ' ')" }
    $acl = & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /C /Q 2>&1
    if ($LASTEXITCODE -ne 0) { Write-SetupLog "  icacls: $($acl -join ' ')" }
    $kids = & icacls.exe (Join-Path $DataDir '*') /reset /T /C /Q 2>&1
    if ($LASTEXITCODE -ne 0) { Write-SetupLog "  icacls reset: $($kids -join ' ')" }
    $cfgFile = Join-Path $DataDir 'config.json'
    if (Test-Path -LiteralPath $cfgFile) {
      try { [void][IO.File]::ReadAllText($cfgFile) } catch { Write-SetupLog "  settings file still can't be read: $($_.Exception.Message)" }
    }
    Set-Step settings done $note

    # 4. Service -------------------------------------------------------------
    Set-Step service active 'Setting up the Photon service'
    Remove-PhotonService
    $esc = { param($s) [Security.SecurityElement]::Escape([string]$s) }
    $xml = @"
<service>
  <id>$ServiceId</id>
  <name>Photon</name>
  <description>Photon: changes the lights in each room when something plays on your media server.</description>
  <executable>$(& $esc $node.Path)</executable>
  <arguments>"$(& $esc (Join-Path $app 'src\server.js'))"</arguments>
  <workingdirectory>$(& $esc $app)</workingdirectory>
  <env name="PORT" value="$($o.Port)"/>
  <env name="CONFIG_PATH" value="$(& $esc (Join-Path $DataDir 'config.json'))"/>
  <env name="NODE_ENV" value="production"/>
  <env name="PHOTON_SERVICE" value="1"/>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="2 min"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>$(& $esc (Join-Path $DataDir 'logs'))</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>5120</sizeThreshold>
    <keepFiles>4</keepFiles>
  </log>
</service>
"@
    [IO.File]::WriteAllText((Join-Path $svcDir 'PhotonService.xml'), $xml, [Text.UTF8Encoding]::new($false))
    & $svcExe install 2>&1 | ForEach-Object { Write-SetupLog "  $_" }
    if (-not (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) { throw 'Windows didn''t accept the Photon service. The setup log has the details.' }
    Set-Step service done 'Starts with Windows, restarts itself if it stops'

    # 5. Firewall ------------------------------------------------------------
    $httpsPort = 8443
    try {
      $cfg = Get-Content -LiteralPath (Join-Path $DataDir 'config.json') -Raw -ErrorAction Stop | ConvertFrom-Json
      if ($cfg.tls -and $cfg.tls.httpsPort) { $httpsPort = [int]$cfg.tls.httpsPort }
    } catch { }
    Get-NetFirewallRule -Group 'Photon' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    if ($o.Firewall) {
      Set-Step firewall active
      New-NetFirewallRule -DisplayName 'Photon: web page' -Group 'Photon' -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort @($o.Port, $httpsPort) -Profile Domain, Private -RemoteAddress LocalSubnet | Out-Null
      New-NetFirewallRule -DisplayName 'Photon: Govee light replies' -Group 'Photon' -Direction Inbound -Action Allow -Protocol UDP `
        -LocalPort 4002 -Profile Domain, Private -RemoteAddress LocalSubnet | Out-Null
      Set-Step firewall done "Ports $($o.Port) and $httpsPort, home network only"
    } else {
      Set-Step firewall skipped 'Turned off'
    }

    # 6. Start menu, desktop and Settings > Apps -----------------------------
    Set-Step shortcuts active
    $wsh = New-Object -ComObject WScript.Shell
    $programs = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
    $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
    # Older versions used a folder with a web shortcut in it. Shortcuts (.lnk) show the logo reliably
    # and can be pinned, so replace those.
    Remove-Item -LiteralPath (Join-Path $programs 'Photon') -Recurse -Force -ErrorAction SilentlyContinue
    $explorer = Join-Path $env:WINDIR 'explorer.exe'
    function New-PhotonShortcut([string]$Path) {
      $lnk = $wsh.CreateShortcut($Path)
      $lnk.TargetPath = $explorer   # explorer.exe opens the address in the default browser
      $lnk.Arguments = "http://localhost:$($o.Port)/"
      $lnk.IconLocation = "$ico,0"
      $lnk.Description = 'Open Photon'
      $lnk.Save()
    }
    New-PhotonShortcut (Join-Path $programs 'Photon.lnk')
    $deskLnk = Join-Path $desktop 'Photon.lnk'
    if ($o.DesktopIcon) { New-PhotonShortcut $deskLnk }
    else { Remove-Item -LiteralPath $deskLnk -Force -ErrorAction SilentlyContinue }
    # Refresh icons that Windows may have cached from an earlier install.
    try { & ie4uinit.exe -show 2>&1 | Out-Null } catch { }
    New-Item -Path $UninstallKey -Force | Out-Null
    $size = [int]((Get-ChildItem -LiteralPath $o.InstallDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1KB)
    $props = @{
      DisplayName = 'Photon'; DisplayVersion = $o.Version; Publisher = 'Photon'; DisplayIcon = $ico
      InstallLocation = $o.InstallDir; UninstallString = "`"$(Join-Path $o.InstallDir 'Uninstall Photon.exe')`""
      QuietUninstallString = "`"$(Join-Path $o.InstallDir 'Uninstall Photon.exe')`" -Quiet"
      URLInfoAbout = "http://localhost:$($o.Port)/"; PhotonPort = "$($o.Port)"; PhotonDataDir = $DataDir
      PhotonDesktopIcon = [string][int][bool]$o.DesktopIcon
    }
    foreach ($k in $props.Keys) { Set-ItemProperty -Path $UninstallKey -Name $k -Value $props[$k] }
    foreach ($k in 'NoModify', 'NoRepair') { New-ItemProperty -Path $UninstallKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
    New-ItemProperty -Path $UninstallKey -Name EstimatedSize -Value $size -PropertyType DWord -Force | Out-Null
    Set-Step shortcuts done $(if ($o.DesktopIcon) { 'Start menu, desktop and Settings > Apps' } else { 'Start menu and Settings > Apps' })

    # 7. Start and check it answers ------------------------------------------
    Set-Step start active 'Starting Photon'
    Start-Service -Name $ServiceId
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Milliseconds 750
      try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($o.Port)/api/version" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
      } catch { }
      $s = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
      if ($i -gt 8 -and $s -and $s.Status -eq 'Stopped') { break }
    }
    if (-not $ok) {
      $tail = ''
      # WinSW names its logs after itself: PhotonService.out.log, .err.log, .wrapper.log
      $logs = Get-ChildItem -LiteralPath (Join-Path $DataDir 'logs') -Filter 'PhotonService*.log' -ErrorAction SilentlyContinue |
        Sort-Object -Property LastWriteTime -Descending | Select-Object -First 3
      foreach ($lf in $logs) { $tail += "`r`n--- $($lf.Name) ---`r`n" + ((Get-Content -LiteralPath $lf.FullName -Tail 15) -join "`r`n") }
      Write-SetupLog "Photon didn't answer. $tail"
      throw "Photon was installed but didn't start answering on port $($o.Port). The service log is in $DataDir\logs."
    }
    Set-Step start done "Running on port $($o.Port)"

    $public = @()
    try { $public = @(Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_.NetworkCategory -eq 'Public' } | Select-Object -ExpandProperty Name) } catch { }
    $sync.Result = @{ Ok = $true; Port = $o.Port; Lan = @(Get-LanAddresses); PublicNetworks = $public; Firewall = $o.Firewall }
  } catch {
    $msg = $_.Exception.Message
    Write-SetupLog "FAILED: $msg"
    Write-SetupLog ($_.ScriptStackTrace | Out-String)
    if ($sync.Current) { Set-Step $sync.Current failed $msg }
    $sync.Result = @{ Ok = $false; Error = $msg }
  } finally {
    try {
      New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'logs') | Out-Null
      Copy-Item -LiteralPath $sync.LogFile -Destination (Join-Path $DataDir 'logs\install.log') -Force
      $sync.LogCopy = Join-Path $DataDir 'logs\install.log'
    } catch { }
    $sync.Done = $true
  }
}

$UninstallWork = {
  $o = $sync.Options
  try {
    $dir = $o.InstallDir
    Set-Step service active 'Stopping Photon'
    $svc = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
    if ($svc) {
      if ($svc.Status -ne 'Stopped') { Stop-Service -Name $ServiceId -Force -ErrorAction SilentlyContinue; try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { } }
      $exe = if ($dir) { Join-Path $dir 'service\PhotonService.exe' } else { $null }
      if ($exe -and (Test-Path -LiteralPath $exe)) { & $exe uninstall 2>&1 | ForEach-Object { Write-SetupLog "  $_" } }
      if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) { & sc.exe delete $ServiceId 2>&1 | ForEach-Object { Write-SetupLog "  $_" } }
    }
    Stop-StrayPhoton ([int]$o.OldPort) $dir
    Set-Step service done 'Service removed'

    Set-Step firewall active
    Get-NetFirewallRule -Group 'Photon' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    Set-Step firewall done 'Rules removed'

    Set-Step files active 'Removing Photon'
    # The "Uninstall Photon.exe" launcher exits right after starting this, give it a moment.
    Start-Sleep -Seconds 1
    if ($dir -and (Test-Path -LiteralPath $dir)) {
      for ($i = 0; $i -lt 10; $i++) {
        try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop; break } catch { Start-Sleep -Seconds 1 }
      }
      if (Test-Path -LiteralPath $dir) {
        # Something still had a file open (usually the uninstall launcher itself). Finish the job a few seconds from now.
        Write-SetupLog "Some files in $dir were still in use, removing them shortly."
        Start-Process -FilePath cmd.exe -ArgumentList "/c timeout /t 5 /nobreak >nul & rmdir /s /q `"$dir`"" -WindowStyle Hidden
      }
    }
    Set-Step files done $dir

    Set-Step shortcuts active
    Remove-Item -LiteralPath (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Photon') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Photon.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Photon.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
    Set-Step shortcuts done 'Start menu, desktop and Settings > Apps entries removed'

    if ($o.DeleteData) {
      Set-Step settings active
      Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
      Set-Step settings done 'Rooms and settings deleted'
    } else {
      Set-Step settings skipped "Kept in $DataDir"
    }
    $sync.Result = @{ Ok = $true; KeptData = -not $o.DeleteData }
  } catch {
    $msg = $_.Exception.Message
    Write-SetupLog "FAILED: $msg"
    if ($sync.Current) { Set-Step $sync.Current failed $msg }
    $sync.Result = @{ Ok = $false; Error = $msg }
  } finally {
    $sync.Done = $true
  }
}

. $Common

# ---------------------------------------------------------------------------
# Work out what we're doing.
$Mode = if ($Uninstall) { 'uninstall' } else { 'install' }
$Assets = Join-Path $Payload 'installer\assets'
if (-not (Test-Path -LiteralPath $Assets)) { $Assets = Join-Path $Payload 'assets' }
$existing = Get-Existing
$Version = '1.0.0'
try { $Version = (Get-Content -LiteralPath (Join-Path $Payload 'app\package.json') -Raw | ConvertFrom-Json).version } catch { if ($existing.Version) { $Version = $existing.Version } }
$ShortVersion = $Version -replace '\.0$', ''
$defaultDir = if ($InstallDir) { $InstallDir } elseif ($existing.InstallDir) { $existing.InstallDir } else { $DefaultInstallDir }
$defaultPort = if ($Port -gt 0) { $Port } elseif ($existing.Port) { $existing.Port } else { 8787 }
$NodeFound = Get-NodeInfo

function Start-Work([hashtable]$Options) {
  $sync.Options = $Options
  $sync.Done = $false
  $body = if ($Mode -eq 'uninstall') { $UninstallWork } else { $InstallWork }
  $script = "param(`$sync)`n" + $Common.ToString() + "`n" + $body.ToString()
  $rs = [runspacefactory]::CreateRunspace()
  $rs.ApartmentState = 'STA'
  $rs.Open()
  $ps = [powershell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript($script).AddArgument($sync)
  $script:WorkHandle = $ps.BeginInvoke()
  $script:WorkPs = $ps
}

function New-InstallOptions([string]$Dir, [int]$PortNumber, [bool]$Firewall, [string]$Import, [bool]$DesktopIcon = $true) {
  @{
    Mode = 'install'; Version = $Version; Payload = $Payload; InstallDir = $Dir.TrimEnd('\')
    Port = $PortNumber; Firewall = $Firewall; ImportFrom = $Import; DesktopIcon = $DesktopIcon
    OldPort = [int]$(if ($existing.Port) { $existing.Port } else { 0 })
  }
}

# ---------------------------------------------------------------------------
# No window: for scripted installs.
if ($Quiet) {
  Remove-Item -LiteralPath $sync.LogFile -Force -ErrorAction SilentlyContinue
  if ($Mode -eq 'uninstall') {
    $sync.Options = @{ InstallDir = $existing.InstallDir; DeleteData = [bool]$DeleteData; OldPort = [int]$(if ($existing.Port) { $existing.Port } else { 0 }) }
  } else {
    $sync.Options = New-InstallOptions $defaultDir $defaultPort (-not $NoFirewall) $ImportFrom ($existing.DesktopIcon -and -not $NoDesktopIcon)
  }
  $body = if ($Mode -eq 'uninstall') { $UninstallWork } else { $InstallWork }
  . $body
  while ($sync.Log.Count) { $l = $null; if ($sync.Log.TryDequeue([ref]$l)) { Write-Output $l } }
  if ($sync.Result.Ok) { exit 0 } else { exit 1 }
}

# ---------------------------------------------------------------------------
# The window.
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Photon Setup" Width="860" Height="630" WindowStartupLocation="CenterScreen"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent" ResizeMode="NoResize"
        UseLayoutRounding="True" SnapsToDevicePixels="True" TextOptions.TextFormattingMode="Display">
  <Window.Resources>
    <SolidColorBrush x:Key="Bg" Color="#04060D"/>
    <SolidColorBrush x:Key="SideBg" Color="#070B17"/>
    <SolidColorBrush x:Key="Panel" Color="#0A0F1E"/>
    <SolidColorBrush x:Key="Panel2" Color="#0F1529"/>
    <SolidColorBrush x:Key="Raise" Color="#141C35"/>
    <SolidColorBrush x:Key="Line" Color="#1C2646"/>
    <SolidColorBrush x:Key="Line2" Color="#2A3762"/>
    <SolidColorBrush x:Key="Text" Color="#E8EEFF"/>
    <SolidColorBrush x:Key="Muted" Color="#8E98BC"/>
    <SolidColorBrush x:Key="Faint" Color="#5D678C"/>
    <SolidColorBrush x:Key="Cyan" Color="#38D9FF"/>
    <SolidColorBrush x:Key="Ok" Color="#3EE0A1"/>
    <SolidColorBrush x:Key="Warn" Color="#FFC457"/>
    <SolidColorBrush x:Key="Bad" Color="#FF5F7E"/>
    <SolidColorBrush x:Key="Inset" Color="#070B17"/>
    <SolidColorBrush x:Key="SwitchOff" Color="#222B4B"/>
    <SolidColorBrush x:Key="Knob" Color="#AAB3D6"/>
    <Color x:Key="Glow1">#292F6BFF</Color>
    <Color x:Key="Glow2">#1AA44DFF</Color>
    <LinearGradientBrush x:Key="Spectrum" StartPoint="0,0" EndPoint="1,0">
      <GradientStop Color="#2F6BFF" Offset="0"/>
      <GradientStop Color="#38D9FF" Offset="0.55"/>
      <GradientStop Color="#A44DFF" Offset="1"/>
    </LinearGradientBrush>
    <FontFamily x:Key="UiFont">Segoe UI</FontFamily>
    <FontFamily x:Key="DisplayFont">Segoe UI Semibold</FontFamily>

    <Style TargetType="TextBlock">
      <Setter Property="FontFamily" Value="{DynamicResource UiFont}"/>
      <Setter Property="Foreground" Value="{DynamicResource Text}"/>
      <Setter Property="FontSize" Value="14"/>
    </Style>

    <Style x:Key="BtnBase" TargetType="Button">
      <Setter Property="FontFamily" Value="{DynamicResource UiFont}"/>
      <Setter Property="FontWeight" Value="Medium"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Padding" Value="20,9"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
      <Setter Property="MinWidth" Value="96"/>
    </Style>
    <Style x:Key="BtnPrimary" TargetType="Button" BasedOn="{StaticResource BtnBase}">
      <Setter Property="Foreground" Value="#04060D"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="9" Background="{DynamicResource Spectrum}" BorderBrush="Transparent" BorderThickness="2" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.9"/></Trigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.78"/></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="b" Property="BorderBrush" Value="{DynamicResource Text}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.4"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="BtnSecondary" TargetType="Button" BasedOn="{StaticResource BtnBase}">
      <Setter Property="Foreground" Value="{DynamicResource Text}"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="9" Background="{DynamicResource Panel2}" BorderBrush="{DynamicResource Line2}" BorderThickness="1" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="{DynamicResource Raise}"/></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="b" Property="BorderBrush" Value="{DynamicResource Cyan}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="BtnGhost" TargetType="Button" BasedOn="{StaticResource BtnBase}">
      <Setter Property="Foreground" Value="{DynamicResource Muted}"/>
      <Setter Property="MinWidth" Value="0"/>
      <Setter Property="Padding" Value="10,6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" CornerRadius="8" Background="Transparent" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Background" Value="{DynamicResource Raise}"/><Setter Property="Foreground" Value="{DynamicResource Text}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.35"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="TextBox">
      <Setter Property="FontFamily" Value="{DynamicResource UiFont}"/>
      <Setter Property="FontSize" Value="14"/>
      <Setter Property="Foreground" Value="{DynamicResource Text}"/>
      <Setter Property="CaretBrush" Value="{DynamicResource Text}"/>
      <Setter Property="SelectionBrush" Value="{DynamicResource Cyan}"/>
      <Setter Property="Background" Value="{DynamicResource Inset}"/>
      <Setter Property="BorderBrush" Value="{DynamicResource Line2}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="10,8"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="TextBox">
            <Border x:Name="b" CornerRadius="8" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}">
              <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}" VerticalAlignment="{TemplateBinding VerticalContentAlignment}" Focusable="False"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="b" Property="BorderBrush" Value="{DynamicResource Cyan}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.5"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="Toggle" TargetType="CheckBox">
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="FocusVisualStyle" Value="{x:Null}"/>
      <Setter Property="Foreground" Value="{DynamicResource Text}"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <Grid Background="Transparent">
              <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <Border x:Name="track" Width="38" Height="22" CornerRadius="11" Background="{DynamicResource SwitchOff}" VerticalAlignment="Top" Margin="0,1,0,0" BorderThickness="2" BorderBrush="Transparent">
                <Ellipse x:Name="knob" Width="14" Height="14" Fill="{DynamicResource Knob}" HorizontalAlignment="Left" Margin="2,0,0,0"/>
              </Border>
              <ContentPresenter Grid.Column="1" Margin="12,0,0,0" VerticalAlignment="Top"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="track" Property="Background" Value="{DynamicResource Spectrum}"/>
                <Setter TargetName="knob" Property="HorizontalAlignment" Value="Right"/>
                <Setter TargetName="knob" Property="Margin" Value="0,0,2,0"/>
                <Setter TargetName="knob" Property="Fill" Value="White"/>
              </Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="track" Property="BorderBrush" Value="{DynamicResource Cyan}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.5"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="ProgressBar">
      <Setter Property="Height" Value="6"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ProgressBar">
            <Grid>
              <Border CornerRadius="3" Background="{DynamicResource Raise}"/>
              <Border x:Name="PART_Track"/>
              <Border x:Name="PART_Indicator" CornerRadius="3" Background="{DynamicResource Spectrum}" HorizontalAlignment="Left"/>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Border x:Name="Frame" Margin="14" CornerRadius="16" Background="{DynamicResource Bg}" BorderBrush="{DynamicResource Line}" BorderThickness="1">
    <Border.Effect><DropShadowEffect BlurRadius="24" ShadowDepth="4" Opacity="0.45" Color="#000000"/></Border.Effect>
    <Grid>
      <!-- the soft blue and violet glow from the app background -->
      <Border CornerRadius="16" IsHitTestVisible="False">
        <Border.Background>
          <RadialGradientBrush Center="0.1,-0.05" GradientOrigin="0.1,-0.05" RadiusX="0.85" RadiusY="0.7">
            <GradientStop x:Name="GlowStop1" Color="#292F6BFF" Offset="0"/>
            <GradientStop Color="#002F6BFF" Offset="1"/>
          </RadialGradientBrush>
        </Border.Background>
      </Border>
      <Border CornerRadius="16" IsHitTestVisible="False">
        <Border.Background>
          <RadialGradientBrush Center="1,0" GradientOrigin="1,0" RadiusX="0.6" RadiusY="0.55">
            <GradientStop x:Name="GlowStop2" Color="#1AA44DFF" Offset="0"/>
            <GradientStop Color="#00A44DFF" Offset="1"/>
          </RadialGradientBrush>
        </Border.Background>
      </Border>

      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="236"/>
          <ColumnDefinition Width="*"/>
        </Grid.ColumnDefinitions>

        <!-- Sidebar -->
        <Border x:Name="Side" Grid.Column="0" CornerRadius="16,0,0,16" Background="{DynamicResource SideBg}" BorderBrush="{DynamicResource Line}" BorderThickness="0,0,1,0">
          <DockPanel Margin="24,26,20,22">
            <StackPanel DockPanel.Dock="Top" Orientation="Horizontal">
              <Border Width="38" Height="38" CornerRadius="10" ClipToBounds="True">
                <Border.Background><ImageBrush x:Name="MarkBrush" Stretch="UniformToFill"/></Border.Background>
              </Border>
              <TextBlock Text="Photon" FontFamily="{DynamicResource DisplayFont}" FontWeight="SemiBold" FontSize="23" Margin="11,0,0,1" VerticalAlignment="Center" Foreground="{DynamicResource Spectrum}"/>
            </StackPanel>
            <TextBlock x:Name="SideFoot" DockPanel.Dock="Bottom" Foreground="{DynamicResource Faint}" FontSize="12" TextWrapping="Wrap"/>
            <StackPanel x:Name="SideSteps" Margin="0,40,0,0"/>
          </DockPanel>
        </Border>

        <!-- Main -->
        <Grid Grid.Column="1">
          <Grid.RowDefinitions>
            <RowDefinition Height="46"/>
            <RowDefinition Height="*"/>
            <RowDefinition Height="Auto"/>
          </Grid.RowDefinitions>

          <Grid x:Name="TitleBar" Grid.Row="0" Background="Transparent">
            <Button x:Name="BtnClose" Style="{StaticResource BtnGhost}" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="0,6,12,0" ToolTip="Close">
              <TextBlock Text="&#xE8BB;" FontFamily="Segoe MDL2 Assets" FontSize="11" Foreground="{Binding Foreground, RelativeSource={RelativeSource AncestorType=Button}}"/>
            </Button>
          </Grid>

          <Grid Grid.Row="1" Margin="40,0,40,0">
            <!-- Welcome -->
            <StackPanel x:Name="PageWelcome">
              <Border x:Name="Hero" Height="148" CornerRadius="12" BorderBrush="{DynamicResource Line}" BorderThickness="1">
                <Border.Background><ImageBrush x:Name="HeroBrush" Stretch="UniformToFill" AlignmentY="Center"/></Border.Background>
              </Border>
              <TextBlock x:Name="WelcomeTitle" FontFamily="{DynamicResource DisplayFont}" FontWeight="SemiBold" FontSize="26" Margin="0,22,0,6"/>
              <TextBlock x:Name="WelcomeLead" Foreground="{DynamicResource Muted}" FontSize="14.5" TextWrapping="Wrap" LineHeight="21"/>
              <Border Margin="0,18,0,0" Background="{DynamicResource Panel}" BorderBrush="{DynamicResource Line}" BorderThickness="1" CornerRadius="12" Padding="16,12">
                <StackPanel x:Name="PlanList"/>
              </Border>
            </StackPanel>

            <!-- Options -->
            <StackPanel x:Name="PageOptions" Visibility="Collapsed">
              <TextBlock Text="Choose how Photon runs" FontFamily="{DynamicResource DisplayFont}" FontWeight="SemiBold" FontSize="24" Margin="0,4,0,18"/>

              <TextBlock Text="Install folder" Foreground="{DynamicResource Muted}" FontSize="13" Margin="0,0,0,6"/>
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <TextBox x:Name="TxtDir"/>
                <Button x:Name="BtnDir" Grid.Column="1" Content="Browse" Style="{StaticResource BtnSecondary}" Margin="8,0,0,0" MinWidth="0"/>
              </Grid>

              <TextBlock Text="Web page port" Foreground="{DynamicResource Muted}" FontSize="13" Margin="0,16,0,6"/>
              <StackPanel Orientation="Horizontal">
                <TextBox x:Name="TxtPort" Width="110"/>
                <TextBlock x:Name="PortStatus" VerticalAlignment="Center" Margin="12,0,0,0" FontSize="13" TextWrapping="Wrap" MaxWidth="330"/>
                <Button x:Name="BtnFreePort" Content="Stop it" Style="{StaticResource BtnSecondary}" Margin="10,0,0,0" Padding="12,6" MinWidth="0" Visibility="Collapsed"/>
              </StackPanel>

              <CheckBox x:Name="ChkFirewall" Style="{StaticResource Toggle}" IsChecked="True" Margin="0,20,0,0">
                <StackPanel>
                  <TextBlock Text="Let other devices on my network open Photon"/>
                  <TextBlock Text="Adds Windows Firewall rules for your home network only." Foreground="{DynamicResource Muted}" FontSize="12.5" Margin="0,2,0,0"/>
                </StackPanel>
              </CheckBox>

              <CheckBox x:Name="ChkDesktop" Style="{StaticResource Toggle}" IsChecked="True" Margin="0,14,0,0">
                <StackPanel>
                  <TextBlock Text="Put a Photon icon on the desktop"/>
                  <TextBlock Text="Photon is always in the Start menu too." Foreground="{DynamicResource Muted}" FontSize="12.5" Margin="0,2,0,0"/>
                </StackPanel>
              </CheckBox>

              <StackPanel x:Name="ImportBox" Margin="0,18,0,0">
                <TextBlock Text="Bring over your rooms and settings (optional)" Foreground="{DynamicResource Muted}" FontSize="13" Margin="0,0,0,6"/>
                <Grid>
                  <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                  <TextBox x:Name="TxtImport"/>
                  <Button x:Name="BtnImport" Grid.Column="1" Content="Browse" Style="{StaticResource BtnSecondary}" Margin="8,0,0,0" MinWidth="0"/>
                </Grid>
                <TextBlock x:Name="ImportHint" Text="Pick the folder you unzipped Photon into before. Leave it empty to start fresh." Foreground="{DynamicResource Faint}" FontSize="12.5" Margin="0,6,0,0" TextWrapping="Wrap"/>
              </StackPanel>
              <TextBlock x:Name="KeepNote" Visibility="Collapsed" Margin="0,18,0,0" Foreground="{DynamicResource Muted}" FontSize="13" TextWrapping="Wrap"/>
            </StackPanel>

            <!-- Remove (uninstall) -->
            <StackPanel x:Name="PageRemove" Visibility="Collapsed">
              <TextBlock Text="Remove Photon" FontFamily="{DynamicResource DisplayFont}" FontWeight="SemiBold" FontSize="26" Margin="0,8,0,8"/>
              <TextBlock Foreground="{DynamicResource Muted}" FontSize="14.5" TextWrapping="Wrap" LineHeight="21"
                         Text="This stops the Photon service and removes Photon from this computer. Node.js stays installed, since other programs may use it."/>
              <CheckBox x:Name="ChkDeleteData" Style="{StaticResource Toggle}" Margin="0,24,0,0">
                <StackPanel>
                  <TextBlock Text="Also delete my rooms, layouts and settings"/>
                  <TextBlock x:Name="DeleteHint" Foreground="{DynamicResource Muted}" FontSize="12.5" Margin="0,2,0,0" TextWrapping="Wrap"/>
                </StackPanel>
              </CheckBox>
            </StackPanel>

            <!-- Progress -->
            <DockPanel x:Name="PageProgress" Visibility="Collapsed">
              <TextBlock x:Name="ProgTitle" DockPanel.Dock="Top" FontFamily="{DynamicResource DisplayFont}" FontWeight="SemiBold" FontSize="24" Margin="0,4,0,14"/>
              <StackPanel DockPanel.Dock="Bottom" Margin="0,10,0,0">
                <Grid>
                  <TextBlock x:Name="ProgDetail" Foreground="{DynamicResource Muted}" FontSize="13" TextTrimming="CharacterEllipsis"/>
                  <Button x:Name="BtnLog" Content="Show details" Style="{StaticResource BtnGhost}" HorizontalAlignment="Right" FontSize="12.5"/>
                </Grid>
                <ProgressBar x:Name="ProgBar" Margin="0,8,0,0" Minimum="0" Maximum="100" Visibility="Hidden"/>
              </StackPanel>
              <Grid>
                <StackPanel x:Name="StepList"/>
                <TextBox x:Name="LogBox" Visibility="Collapsed" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled"
                         FontFamily="Cascadia Mono, Consolas" FontSize="12" Padding="10" VerticalContentAlignment="Top">
                  <TextBox.Resources>
                    <Style TargetType="ScrollBar">
                      <Setter Property="Width" Value="8"/>
                      <Setter Property="Template">
                        <Setter.Value>
                          <ControlTemplate TargetType="ScrollBar">
                            <Track x:Name="PART_Track" IsDirectionReversed="True">
                              <Track.Thumb>
                                <Thumb>
                                  <Thumb.Template>
                                    <ControlTemplate TargetType="Thumb"><Border CornerRadius="4" Background="{DynamicResource Line2}"/></ControlTemplate>
                                  </Thumb.Template>
                                </Thumb>
                              </Track.Thumb>
                            </Track>
                          </ControlTemplate>
                        </Setter.Value>
                      </Setter>
                    </Style>
                  </TextBox.Resources>
                </TextBox>
              </Grid>
            </DockPanel>

            <!-- Done -->
            <StackPanel x:Name="PageDone" Visibility="Collapsed">
              <Border x:Name="DoneBadge" Width="58" Height="58" CornerRadius="29" HorizontalAlignment="Left" Margin="0,10,0,0" Background="{DynamicResource Spectrum}">
                <TextBlock x:Name="DoneGlyph" Text="&#xE73E;" FontFamily="Segoe MDL2 Assets" FontSize="24" Foreground="#04060D" HorizontalAlignment="Center" VerticalAlignment="Center"/>
              </Border>
              <TextBlock x:Name="DoneTitle" FontFamily="{DynamicResource DisplayFont}" FontWeight="SemiBold" FontSize="26" Margin="0,18,0,8"/>
              <TextBlock x:Name="DoneText" Foreground="{DynamicResource Muted}" FontSize="14.5" TextWrapping="Wrap" LineHeight="21"/>
              <Border x:Name="UrlBox" Margin="0,18,0,0" Background="{DynamicResource Panel}" BorderBrush="{DynamicResource Line}" BorderThickness="1" CornerRadius="12" Padding="16,12">
                <StackPanel x:Name="UrlList"/>
              </Border>
              <TextBlock x:Name="DoneNote" Visibility="Collapsed" Foreground="{DynamicResource Warn}" FontSize="13" TextWrapping="Wrap" Margin="0,14,0,0"/>
            </StackPanel>
          </Grid>

          <!-- Footer -->
          <DockPanel Grid.Row="2" Margin="40,12,28,24" LastChildFill="False">
            <TextBlock x:Name="FooterNote" DockPanel.Dock="Left" VerticalAlignment="Center" Foreground="{DynamicResource Faint}" FontSize="12.5"/>
            <Button x:Name="BtnNext" DockPanel.Dock="Right" Style="{StaticResource BtnPrimary}" Margin="10,0,0,0"/>
            <Button x:Name="BtnBack" DockPanel.Dock="Right" Style="{StaticResource BtnSecondary}"/>
          </DockPanel>
        </Grid>
      </Grid>
    </Grid>
  </Border>
</Window>
'@

$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
# Errors inside button handlers and the timer: show them instead of closing silently.
$win.Dispatcher.Add_UnhandledException({
  param($s, $e)
  Show-Fatal (New-Object System.Management.Automation.ErrorRecord ($e.Exception, 'Window', 'NotSpecified', $null))
  $e.Handled = $true
})
$ui = @{}
foreach ($n in $xaml.SelectNodes('//*[@*[local-name()="Name"]]')) {
  $name = $n.Attributes | Where-Object { $_.LocalName -eq 'Name' } | Select-Object -First 1 -ExpandProperty Value
  if ($name) { $ui[$name] = $win.FindName($name) }
}

# ---- look: fonts, images, light or dark like Windows -------------------------------
# PowerShell wraps objects it creates in a PSObject. WPF slots typed as plain "object"
# (resource dictionaries, Button.Content) get that wrapper unless it's removed, and WPF
# then rejects it. Unwrap anything going into such a slot.
function Get-Raw($Value) { if ($null -ne $Value -and $Value.PSObject) { $Value.PSObject.BaseObject } else { $Value } }
function New-Brush([string]$Hex) { $b = [Windows.Media.SolidColorBrush]::new([Windows.Media.ColorConverter]::ConvertFromString($Hex)); $b.Freeze(); return $b }
function Set-Res([string]$Key, $Value) { $win.Resources[$Key] = Get-Raw $Value }

# Photon's fonts. If they can't be used, Windows' own Segoe UI stays (set in the XAML).
try {
  $fontDir = Join-Path $Assets 'fonts'
  if (Test-Path -LiteralPath $fontDir) {
    $fontUri = [Uri]::new('file:///' + ($fontDir -replace '\\', '/') + '/')
    Set-Res 'UiFont' ([Windows.Media.FontFamily]::new($fontUri, './#IBM Plex Sans'))
    Set-Res 'DisplayFont' ([Windows.Media.FontFamily]::new($fontUri, './#Sora'))
  }
} catch {
  try { Add-Content -LiteralPath $sync.LogFile -Value "Fonts not used: $($_.Exception.Message)" } catch { }
}

function Get-Bitmap([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $bmp = New-Object Windows.Media.Imaging.BitmapImage
  $bmp.BeginInit()
  $bmp.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bmp.UriSource = New-Object Uri $Path
  $bmp.EndInit()
  $bmp.Freeze()
  $bmp
}
# Logo images: nice to have, never a reason to stop.
try { $ui.MarkBrush.ImageSource = Get-Raw (Get-Bitmap (Join-Path $Assets 'photon-mark.png')) } catch { }
try { $ui.HeroBrush.ImageSource = Get-Raw (Get-Bitmap (Join-Path $Assets 'photon-hero.png')) } catch { }
try { $win.Icon = [Windows.Media.Imaging.BitmapFrame]::Create((New-Object Uri (Join-Path $Assets 'photon.ico'))) } catch { }

$lightTheme = $false
try { $lightTheme = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme -eq 1 } catch { }
if ($lightTheme) { try {
  $palette = @{
    Bg = '#EEF1F8'; SideBg = '#F7F8FC'; Panel = '#FFFFFF'; Panel2 = '#F4F6FC'; Raise = '#E8EDF8'; Line = '#DDE3F0'; Line2 = '#C6CFE4'
    Text = '#121833'; Muted = '#535C7C'; Faint = '#8B93AD'; Cyan = '#0A87B8'; Ok = '#0D8A5E'; Warn = '#A26800'; Bad = '#D23258'
    Inset = '#FFFFFF'; SwitchOff = '#CDD5E8'; Knob = '#FFFFFF'
  }
  foreach ($k in $palette.Keys) { Set-Res $k (New-Brush $palette[$k]) }
  $ui.GlowStop1.Color = [Windows.Media.ColorConverter]::ConvertFromString('#1A2F6BFF')
  $ui.GlowStop2.Color = [Windows.Media.ColorConverter]::ConvertFromString('#10A44DFF')
  $ui.Frame.Effect.Opacity = 0.18
} catch { try { Add-Content -LiteralPath $sync.LogFile -Value "Light theme not used: $($_.Exception.Message)" } catch { } } }
function Res([string]$Key) { Get-Raw $win.Resources[$Key] }

# ---- small builders ----------------------------------------------------------------
function New-Text([string]$Text, [string]$Brush = 'Text', [double]$Size = 14, [string]$Weight = 'Normal') {
  $t = New-Object Windows.Controls.TextBlock
  $t.Text = $Text
  $t.FontSize = $Size
  $t.TextWrapping = 'Wrap'
  $t.FontWeight = [Windows.FontWeights]::$Weight
  $t.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, $Brush)
  $t.SetResourceReference([Windows.Controls.TextBlock]::FontFamilyProperty, 'UiFont')
  $t
}

function Add-PlanRow([string]$Glyph, [string]$Title, [string]$Detail, [string]$GlyphBrush = 'Cyan') {
  $g = New-Object Windows.Controls.Grid
  $g.Margin = '0,5,0,5'
  $c0 = New-Object Windows.Controls.ColumnDefinition; $c0.Width = '28'
  $c1 = New-Object Windows.Controls.ColumnDefinition
  $g.ColumnDefinitions.Add($c0); $g.ColumnDefinitions.Add($c1)
  $icon = New-Text $Glyph $GlyphBrush 14
  $icon.FontFamily = 'Segoe MDL2 Assets'
  $icon.Margin = '0,2,0,0'
  $sp = New-Object Windows.Controls.StackPanel
  [Windows.Controls.Grid]::SetColumn($sp, 1)
  [void]$sp.Children.Add((New-Text $Title 'Text' 14 'Medium'))
  if ($Detail) { $d = New-Text $Detail 'Muted' 12.5; $d.Margin = '0,1,0,0'; [void]$sp.Children.Add($d) }
  [void]$g.Children.Add($icon); [void]$g.Children.Add($sp)
  [void]$ui.PlanList.Children.Add($g)
}

# Sidebar steps
$sideLabels = if ($Mode -eq 'uninstall') { @('Remove', 'Removing', 'Done') } else { @('Welcome', 'Options', 'Install', 'Done') }
$sideRows = @()
for ($i = 0; $i -lt $sideLabels.Count; $i++) {
  $g = New-Object Windows.Controls.Grid
  $g.Margin = '0,0,0,16'
  $c0 = New-Object Windows.Controls.ColumnDefinition; $c0.Width = '34'
  $g.ColumnDefinitions.Add($c0); $g.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
  $dot = New-Object Windows.Controls.Border
  $dot.Width = 24; $dot.Height = 24; $dot.CornerRadius = 12; $dot.BorderThickness = 1; $dot.HorizontalAlignment = 'Left'
  $num = New-Text ([string]($i + 1)) 'Muted' 12 'SemiBold'
  $num.HorizontalAlignment = 'Center'; $num.VerticalAlignment = 'Center'
  $dot.Child = $num
  $lbl = New-Text $sideLabels[$i] 'Muted' 14 'Medium'
  $lbl.VerticalAlignment = 'Center'
  [Windows.Controls.Grid]::SetColumn($lbl, 1)
  [void]$g.Children.Add($dot); [void]$g.Children.Add($lbl)
  [void]$ui.SideSteps.Children.Add($g)
  $sideRows += , @{ Dot = $dot; Num = $num; Label = $lbl }
}
function Set-SideStep([int]$Index) {
  for ($i = 0; $i -lt $sideRows.Count; $i++) {
    $r = $sideRows[$i]
    if ($i -lt $Index) {
      $r.Dot.Background = Res 'Spectrum'; $r.Dot.BorderBrush = [Windows.Media.Brushes]::Transparent
      $r.Num.Text = [char]0xE73E; $r.Num.FontFamily = 'Segoe MDL2 Assets'; $r.Num.FontSize = 11; $r.Num.Foreground = New-Brush '#04060D'
      $r.Label.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Muted')
    } elseif ($i -eq $Index) {
      $r.Dot.Background = Res 'Raise'; $r.Dot.BorderBrush = Res 'Cyan'
      $r.Num.Text = [string]($i + 1); $r.Num.SetResourceReference([Windows.Controls.TextBlock]::FontFamilyProperty, 'UiFont'); $r.Num.FontSize = 12
      $r.Num.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Text')
      $r.Label.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Text')
    } else {
      $r.Dot.Background = [Windows.Media.Brushes]::Transparent; $r.Dot.BorderBrush = Res 'Line2'
      $r.Num.Text = [string]($i + 1); $r.Num.SetResourceReference([Windows.Controls.TextBlock]::FontFamilyProperty, 'UiFont'); $r.Num.FontSize = 12
      $r.Num.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Faint')
      $r.Label.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Faint')
    }
  }
}

# Progress steps
$stepDefs = if ($Mode -eq 'uninstall') {
  [ordered]@{ service = 'Stop and remove the Photon service'; firewall = 'Remove firewall rules'; files = 'Remove Photon''s files'; shortcuts = 'Remove Start menu, desktop and Settings entries'; settings = 'Your rooms and settings' }
} else {
  [ordered]@{ node = 'Check for Node.js'; download = 'Download Node.js'; nodeinstall = 'Install Node.js'; files = 'Copy Photon'; settings = 'Set up your settings'; service = 'Install the Photon service'; firewall = 'Open the firewall for your network'; shortcuts = 'Add Start menu and desktop shortcuts'; start = 'Start Photon' }
}
$stepRows = @{}
foreach ($id in $stepDefs.Keys) {
  $g = New-Object Windows.Controls.Grid
  $g.Margin = '0,0,0,9'
  $c0 = New-Object Windows.Controls.ColumnDefinition; $c0.Width = '30'
  $c1 = New-Object Windows.Controls.ColumnDefinition; $c1.Width = 'Auto'
  $c2 = New-Object Windows.Controls.ColumnDefinition
  $g.ColumnDefinitions.Add($c0); $g.ColumnDefinitions.Add($c1); $g.ColumnDefinitions.Add($c2)
  $icon = New-Text ([string][char]0xEA3A) 'Faint' 13
  $icon.FontFamily = 'Segoe MDL2 Assets'; $icon.VerticalAlignment = 'Center'
  $lbl = New-Text $stepDefs[$id] 'Faint' 14
  $lbl.TextWrapping = 'NoWrap'
  [Windows.Controls.Grid]::SetColumn($lbl, 1)
  $note = New-Text '' 'Faint' 12.5
  $note.TextWrapping = 'NoWrap'; $note.TextTrimming = 'CharacterEllipsis'; $note.Margin = '12,1,0,0'; $note.VerticalAlignment = 'Center'
  [Windows.Controls.Grid]::SetColumn($note, 2)
  [void]$g.Children.Add($icon); [void]$g.Children.Add($lbl); [void]$g.Children.Add($note)
  [void]$ui.StepList.Children.Add($g)
  $stepRows[$id] = @{ Icon = $icon; Label = $lbl; Note = $note }
}

$glyph = @{ pending = 0xEA3A; active = 0xF137; done = 0xE73E; failed = 0xE711; skipped = 0xE738 }
$tick = 0
function Update-Steps {
  foreach ($id in $stepRows.Keys) {
    $row = $stepRows[$id]
    $st = $sync.Steps[$id]
    $state = if ($st) { $st.State } else { 'pending' }
    $row.Icon.Text = [string][char]$glyph[$state]
    $brush = @{ pending = 'Faint'; active = 'Cyan'; done = 'Ok'; failed = 'Bad'; skipped = 'Faint' }[$state]
    $row.Icon.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, $brush)
    $row.Icon.Opacity = if ($state -eq 'active' -and ($tick % 2)) { 0.45 } else { 1 }
    $row.Label.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, $(if ($state -eq 'pending' -or $state -eq 'skipped') { 'Faint' } else { 'Text' }))
    $row.Note.Text = if ($st) { $st.Note } else { '' }
    $row.Note.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, $(if ($state -eq 'failed') { 'Bad' } else { 'Muted' }))
  }
}

# ---- pages -------------------------------------------------------------------------
$pages = 'PageWelcome', 'PageOptions', 'PageRemove', 'PageProgress', 'PageDone'
function Show-Page([string]$Name) {
  foreach ($p in $pages) { $ui[$p].Visibility = if ($p -eq $Name) { 'Visible' } else { 'Collapsed' } }
  $script:Page = $Name
  $ui.FooterNote.Text = ''
  switch ($Name) {
    'PageWelcome' { Set-SideStep 0; $ui.BtnBack.Content = 'Cancel'; $ui.BtnBack.Visibility = 'Visible'; $ui.BtnNext.Content = 'Next' }
    'PageOptions' { Set-SideStep 1; $ui.BtnBack.Content = 'Back'; $ui.BtnBack.Visibility = 'Visible'; $ui.BtnNext.Content = $(if ($existing.Installed) { 'Update' } else { 'Install' }); Update-PortStatus }
    'PageRemove' { Set-SideStep 0; $ui.BtnBack.Content = 'Cancel'; $ui.BtnBack.Visibility = 'Visible'; $ui.BtnNext.Content = 'Remove' }
    'PageProgress' { Set-SideStep $(if ($Mode -eq 'uninstall') { 1 } else { 2 }); $ui.BtnBack.Visibility = 'Collapsed'; $ui.BtnNext.IsEnabled = $false; $ui.BtnNext.Content = 'Working'; $ui.BtnClose.IsEnabled = $false }
    'PageDone' { Set-SideStep $(if ($Mode -eq 'uninstall') { 2 } else { 3 }); $ui.BtnNext.IsEnabled = $true; $ui.BtnClose.IsEnabled = $true }
  }
  $ui.BtnNext.Focus() | Out-Null
}

# Welcome
$ui.SideFoot.Text = "Photon $ShortVersion setup"
if ($Mode -eq 'install') {
  $ui.WelcomeTitle.Text = if ($existing.Installed) { "Update Photon to $ShortVersion" } else { "Install Photon $ShortVersion" }
  $ui.WelcomeLead.Text = 'Photon changes the lights in each room when something plays, pauses or stops on your media server. Here is what setup will do:'
  if ($NodeFound -and $NodeFound.Major -ge $MinNodeMajor) {
    Add-PlanRow ([string][char]0xE73E) "Use Node.js $($NodeFound.Version)" 'Already installed on this computer.' 'Ok'
  } elseif ($NodeFound) {
    Add-PlanRow ([string][char]0xE896) 'Update Node.js' "This computer has $($NodeFound.Version). Photon needs 18 or newer, so setup downloads the current LTS version from nodejs.org." 'Cyan'
  } else {
    Add-PlanRow ([string][char]0xE896) 'Download and install Node.js' 'Photon runs on Node.js. Setup gets the current LTS version from nodejs.org, checks it, and installs it.' 'Cyan'
  }
  Add-PlanRow ([string][char]0xE7B8) $(if ($existing.Installed) { 'Replace the Photon files' } else { 'Install Photon' }) 'Everything Photon needs is included, nothing else to download.'
  Add-PlanRow ([string][char]0xE912) 'Run Photon as a Windows service' 'It starts with your computer and keeps running when nobody is signed in.'
  if ($existing.HasSettings) { Add-PlanRow ([string][char]0xE72E) 'Keep your rooms and settings' "They stay in $DataDir." 'Ok' }
} else {
  $ui.DeleteHint.Text = "Leave this off to keep them in $DataDir, in case you install Photon again."
}

# Options
$ui.TxtDir.Text = $defaultDir
$ui.TxtPort.Text = [string]$defaultPort
if ($ImportFrom) { $ui.TxtImport.Text = $ImportFrom }
$ui.ChkDesktop.IsChecked = ($existing.DesktopIcon -and -not $NoDesktopIcon)
if ($existing.HasSettings) {
  $ui.ImportBox.Visibility = 'Collapsed'
  $ui.KeepNote.Visibility = 'Visible'
  $ui.KeepNote.Text = "Your current rooms and settings in $DataDir stay as they are."
}

$script:PortOwner = $null
function Update-PortStatus {
  $ui.BtnFreePort.Visibility = 'Collapsed'
  $p = 0
  if (-not [int]::TryParse($ui.TxtPort.Text.Trim(), [ref]$p) -or $p -lt 1 -or $p -gt 65535) {
    $ui.PortStatus.Text = 'Use a number from 1 to 65535.'
    $ui.PortStatus.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Bad')
    return
  }
  $owner = Get-PortOwner $p
  $script:PortOwner = $owner
  if (-not $owner) {
    $ui.PortStatus.Text = 'Free'
    $ui.PortStatus.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Ok')
  } elseif ($existing.Running -and $p -eq $existing.Port) {
    $ui.PortStatus.Text = 'Used by Photon now, it restarts during the update'
    $ui.PortStatus.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Muted')
    $script:PortOwner = $null
  } else {
    $ui.PortStatus.Text = "In use by $($owner.Name) (process $($owner.ProcessId)). If that's Photon started by hand, stop it first."
    $ui.PortStatus.SetResourceReference([Windows.Controls.TextBlock]::ForegroundProperty, 'Warn')
    $ui.BtnFreePort.Visibility = 'Visible'
    # Started by hand with a full path? Offer that folder's settings.
    if (-not $ui.TxtImport.Text -and $owner.CommandLine -match '"?([A-Za-z]:\\[^"]+?)\\src\\server\.js') {
      if (Find-PhotonData $Matches[1]) { $ui.TxtImport.Text = $Matches[1] }
    }
  }
}
$ui.TxtPort.Add_LostFocus({ Update-PortStatus })
$ui.BtnFreePort.Add_Click({
  if ($script:PortOwner) {
    try { Stop-Process -Id $script:PortOwner.ProcessId -Force; Start-Sleep -Milliseconds 600 } catch { }
  }
  Update-PortStatus
})

function Select-Folder([string]$Description, [string]$Start) {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $Description
  $d.ShowNewFolderButton = $true
  if ($Start -and (Test-Path -LiteralPath $Start)) { $d.SelectedPath = $Start }
  if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $d.SelectedPath }
  return $null
}
$ui.BtnDir.Add_Click({ $f = Select-Folder 'Where should Photon be installed?' $ui.TxtDir.Text; if ($f) { $ui.TxtDir.Text = $f } })
$ui.BtnImport.Add_Click({
  $f = Select-Folder 'Pick the folder of the Photon you used before (the one with a "data" folder in it).' $ui.TxtImport.Text
  if ($f) { $ui.TxtImport.Text = $f; if (-not (Find-PhotonData $f)) { $ui.FooterNote.Text = 'No Photon settings found in that folder.' } else { $ui.FooterNote.Text = '' } }
})

# ---- running the work --------------------------------------------------------------
$ui.ProgTitle.Text = if ($Mode -eq 'uninstall') { 'Removing Photon' } elseif ($existing.Installed) { 'Updating Photon' } else { 'Installing Photon' }
$ui.BtnLog.Add_Click({
  if ($ui.LogBox.Visibility -eq 'Visible') { $ui.LogBox.Visibility = 'Collapsed'; $ui.StepList.Visibility = 'Visible'; $ui.BtnLog.Content = 'Show details' }
  else { $ui.LogBox.Visibility = 'Visible'; $ui.StepList.Visibility = 'Collapsed'; $ui.BtnLog.Content = 'Hide details' }
})

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(150)
$timer.Add_Tick({
  $script:tick++
  $line = $null
  $added = $false
  while ($sync.Log.TryDequeue([ref]$line)) { $ui.LogBox.AppendText($line + "`r`n"); $added = $true }
  if ($added) { $ui.LogBox.ScrollToEnd() }
  if ($script:tick % 3 -eq 0) { Update-Steps }
  $cur = if ($sync.Current) { $sync.Steps[$sync.Current] } else { $null }
  if ($sync.Pct -ge 0) {
    $ui.ProgBar.Visibility = 'Visible'; $ui.ProgBar.Value = $sync.Pct
    $ui.ProgDetail.Text = "$($cur.Note)  $($sync.PctText)"
  } else {
    $ui.ProgBar.Visibility = 'Hidden'
    if ($cur) { $ui.ProgDetail.Text = $cur.Note }
  }
  if ($sync.Done) {
    $timer.Stop()
    Update-Steps
    Show-Result
  }
})

function Add-UrlRow([string]$Label, [string]$Url) {
  $g = New-Object Windows.Controls.Grid
  $g.Margin = '0,4,0,4'
  $c0 = New-Object Windows.Controls.ColumnDefinition; $c0.Width = '170'
  $g.ColumnDefinitions.Add($c0); $g.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
  [void]$g.Children.Add((New-Text $Label 'Muted' 13.5))
  $link = New-Object Windows.Controls.Button
  $link.Style = Get-Raw $win.Resources['BtnGhost']
  $link.HorizontalAlignment = 'Left'; $link.Padding = '0'; $link.Margin = '-2,0,0,0'
  $t = New-Text $Url 'Cyan' 13.5 'Medium'
  $link.Content = Get-Raw $t
  $link.Tag = $Url
  $link.Add_Click({ param($s) Start-Process $s.Tag })
  [Windows.Controls.Grid]::SetColumn($link, 1)
  [void]$g.Children.Add($link)
  [void]$ui.UrlList.Children.Add($g)
}

function Show-Result {
  $r = $sync.Result
  Show-Page 'PageDone'
  if ($r.Ok) {
    $script:ExitCode = 0
    if ($Mode -eq 'uninstall') {
      $ui.DoneTitle.Text = 'Photon has been removed'
      $ui.DoneText.Text = if ($r.KeptData) { "Your rooms and settings are still in $DataDir. Install Photon again any time and they'll be there." } else { 'Photon and its settings are gone from this computer.' }
      $ui.UrlBox.Visibility = 'Collapsed'
      $ui.BtnBack.Visibility = 'Collapsed'
      $ui.BtnNext.Content = 'Close'
    } else {
      $ui.DoneTitle.Text = 'Photon is running'
      $ui.DoneText.Text = 'It runs in the background as a Windows service, so it starts with your computer. Open it from the Start menu, or from any device on your network:'
      Add-UrlRow 'On this computer' "http://localhost:$($r.Port)/"
      foreach ($ip in ($r.Lan | Select-Object -First 3)) { Add-UrlRow 'From other devices' "http://$($ip):$($r.Port)/" }
      if ($r.PublicNetworks -and $r.Firewall) {
        $ui.DoneNote.Visibility = 'Visible'
        $ui.DoneNote.Text = "Windows treats the network ""$($r.PublicNetworks -join ', ')"" as public, so other devices can't reach Photon yet. Set it to Private in Settings > Network & internet."
      }
      $ui.BtnBack.Visibility = 'Visible'; $ui.BtnBack.Content = 'Finish'
      $ui.BtnNext.Content = 'Open Photon'
    }
  } else {
    $script:ExitCode = 1
    $ui.DoneBadge.Background = Res 'Bad'
    $ui.DoneGlyph.Text = [string][char]0xE711
    $ui.DoneGlyph.Foreground = [Windows.Media.Brushes]::White
    $ui.DoneTitle.Text = if ($Mode -eq 'uninstall') { "Photon couldn't be fully removed" } else { "Setup couldn't finish" }
    $ui.DoneText.Text = $r.Error
    $ui.UrlList.Children.Clear()
    $logPath = if ($sync.LogCopy) { $sync.LogCopy } else { $sync.LogFile }
    [void]$ui.UrlList.Children.Add((New-Text "The full log is in $logPath" 'Muted' 13))
    $ui.BtnBack.Visibility = 'Visible'; $ui.BtnBack.Content = 'Open log'
    $ui.BtnNext.Content = 'Close'
    $script:LogPath = $logPath
  }
}

# ---- buttons -----------------------------------------------------------------------
$script:ExitCode = 2 # cancelled unless something finishes
$ui.BtnClose.Add_Click({ $win.Close() })
$ui.TitleBar.Add_MouseLeftButtonDown({ $win.DragMove() })
$ui.Side.Add_MouseLeftButtonDown({ $win.DragMove() })
$win.Add_Closing({ param($s, $e) if ($script:Page -eq 'PageProgress') { $e.Cancel = $true } })
$win.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Escape' -and $script:Page -ne 'PageProgress') { $win.Close() } })

$ui.BtnBack.Add_Click({
  switch ($script:Page) {
    'PageOptions' { Show-Page 'PageWelcome' }
    'PageDone' {
      if ($sync.Result -and -not $sync.Result.Ok) { Start-Process notepad.exe -ArgumentList "`"$script:LogPath`"" } else { $win.Close() }
    }
    default { $win.Close() }
  }
})

$ui.BtnNext.Add_Click({
  switch ($script:Page) {
    'PageWelcome' { Show-Page 'PageOptions' }
    'PageOptions' {
      $dir = $ui.TxtDir.Text.Trim()
      $p = 0
      if (-not $dir -or -not [IO.Path]::IsPathRooted($dir)) { $ui.FooterNote.Text = 'Pick a full folder path, like C:\Program Files\Photon.'; return }
      if (-not [int]::TryParse($ui.TxtPort.Text.Trim(), [ref]$p) -or $p -lt 1 -or $p -gt 65535) { $ui.FooterNote.Text = 'The port has to be a number from 1 to 65535.'; return }
      Update-PortStatus
      if ($script:PortOwner) { $ui.FooterNote.Text = "Port $p is in use. Stop that program or pick another port."; return }
      $import = $ui.TxtImport.Text.Trim()
      if ($ui.ImportBox.Visibility -eq 'Visible' -and $import -and -not (Find-PhotonData $import)) { $ui.FooterNote.Text = "No Photon settings found in $import."; return }
      if ($ui.ImportBox.Visibility -ne 'Visible') { $import = '' }
      Remove-Item -LiteralPath $sync.LogFile -Force -ErrorAction SilentlyContinue
      Show-Page 'PageProgress'
      Start-Work (New-InstallOptions $dir $p ([bool]$ui.ChkFirewall.IsChecked) $import ([bool]$ui.ChkDesktop.IsChecked))
      $timer.Start()
    }
    'PageRemove' {
      Remove-Item -LiteralPath $sync.LogFile -Force -ErrorAction SilentlyContinue
      Show-Page 'PageProgress'
      Start-Work @{ Mode = 'uninstall'; InstallDir = $existing.InstallDir; DeleteData = [bool]$ui.ChkDeleteData.IsChecked; OldPort = [int]$(if ($existing.Port) { $existing.Port } else { 0 }) }
      $timer.Start()
    }
    'PageDone' {
      if ($sync.Result.Ok -and $Mode -eq 'install') { Start-Process "http://localhost:$($sync.Result.Port)/" }
      $win.Close()
    }
  }
})

Update-Steps

if ($PreviewPng) {
  # Sample content so each page can be checked without doing anything to the computer.
  switch ($PreviewPage) {
    'PageProgress' {
      $sync.Steps['node'] = @{ State = 'done'; Note = 'Not installed yet' }
      $sync.Steps['download'] = @{ State = 'active'; Note = 'Downloading Node.js v22.11.0 (Jod LTS)' }
      $sync.Current = 'download'; $sync.Pct = 46; $sync.PctText = '12.3 of 26.6 MB'
      Show-Page 'PageProgress'; Update-Steps
      $ui.ProgBar.Visibility = 'Visible'; $ui.ProgBar.Value = 46; $ui.ProgDetail.Text = 'Downloading Node.js v22.11.0 (Jod LTS)  12.3 of 26.6 MB'
    }
    'PageDone' { $sync.Result = @{ Ok = $true; Port = 8787; Lan = @('192.168.1.60'); PublicNetworks = @(); Firewall = $true }; Show-Result }
    'PageFail' {
      $sync.Steps['node'] = @{ State = 'done'; Note = 'Found Node.js v22.11.0' }
      $sync.Steps['files'] = @{ State = 'done'; Note = 'C:\Program Files\Photon' }
      $sync.Steps['start'] = @{ State = 'failed'; Note = 'Photon did not answer' }
      $sync.Result = @{ Ok = $false; Error = 'Photon was installed but didn''t start answering on port 8787. The service log is in C:\ProgramData\Photon\logs.' }; Show-Result
    }
    default { Show-Page $PreviewPage }
  }
  $win.WindowStartupLocation = 'Manual'; $win.Left = 0; $win.Top = 0
  $win.Show()
  for ($i = 0; $i -lt 20; $i++) { $win.Dispatcher.Invoke([Action]{ }, [Windows.Threading.DispatcherPriority]::Background); Start-Sleep -Milliseconds 50 }
  $bmp = New-Object Windows.Media.Imaging.RenderTargetBitmap ([int]$win.ActualWidth, [int]$win.ActualHeight, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
  $bmp.Render($win)
  $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
  $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
  $fs = [IO.File]::Create($PreviewPng); $enc.Save($fs); $fs.Close()
  $win.Close()
  exit 0
}

if ($Mode -eq 'uninstall') {
  if (-not $existing.Installed) {
    [Windows.MessageBox]::Show('Photon is not installed on this computer.', 'Photon') | Out-Null
    exit 0
  }
  Show-Page 'PageRemove'
} else {
  Show-Page 'PageWelcome'
}
[void]$win.ShowDialog()
if ($script:WorkPs) { try { $script:WorkPs.Dispose() } catch { } }
exit $script:ExitCode
