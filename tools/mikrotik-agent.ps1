$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$configPath = Join-Path $env:LOCALAPPDATA 'TechnchMikrotikAgent\agent.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'Agent not configured. Run setup-mikrotik-agent.ps1 first.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$credential = Import-Clixml -LiteralPath $config.credentialPath
if ($credential -isnot [System.Management.Automation.PSCredential]) { throw 'Saved RouterOS credential is invalid. Rerun setup-mikrotik-agent.ps1.' }
$routerRoot = "$($config.routerUrl)/rest"
$agentHeaders = @{ Authorization = "Bearer $($config.agentToken)" }
$routerPassword = $credential.GetNetworkCredential().Password
$routerBasic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($credential.UserName):$routerPassword"))
$routerHeaders = @{ Authorization = "Basic $routerBasic" }

function Invoke-RouterRest {
  param([string]$Path, [string]$Method = 'Get', $Body = $null)
  $params = @{ Uri = "$routerRoot/$Path"; Method = $Method; Headers = $routerHeaders; TimeoutSec = 12 }
  if ($null -ne $Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Compress -Depth 6) }
  Invoke-RestMethod @params
}

function Test-RouterReachable {
  try {
    Invoke-RouterRest -Path 'system/resource' | Out-Null
    return $true
  } catch {
    Write-Warning "RouterOS health check failed: $($_.Exception.Message)"
    return $false
  }
}

function Send-AgentHeartbeat([bool]$RouterOnline) {
  $body = @{ type = 'heartbeat'; routerOnline = $RouterOnline } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
}

function Normalize-Mac([string]$Mac) { $Mac.Trim().ToLowerInvariant() }
function Apply-Command($Command) {
  $mac = Normalize-Mac $Command.mac_address
  $users = @(Invoke-RouterRest -Path 'ip/hotspot/user')
  $user = $users | Where-Object { $_.name -eq $Command.hotspot_username } | Select-Object -First 1

  if ($Command.action -eq 'ALLOW') {
    $hosts = @(Invoke-RouterRest -Path 'ip/hotspot/host')
    $sameMacHosts = @($hosts | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac })
    $clientHost = $sameMacHosts | Where-Object { $_.address -eq $Command.client_ip } | Select-Object -First 1
    if (-not $clientHost -and $sameMacHosts.Count -eq 1) {
      # DHCP may change the IP while a customer approves the M-Pesa prompt.
      # The paid MAC is still the device identity, so use its current HotSpot IP.
      $clientHost = $sameMacHosts[0]
      Write-Warning "Client IP changed from $($Command.client_ip) to $($clientHost.address); applying the paid grant to the same MAC."
    }
    if (-not $clientHost) {
      # The portal context already binds this paid command to the exact MAC.
      # Provision a MAC-locked user even if the host entry aged out while the
      # customer approved M-Pesa. RouterOS will accept it when that device
      # reconnects; the browser can submit its login as soon as access is live.
      Write-Warning "RouterOS does not currently list the paid MAC $mac as a HotSpot host; provisioning access locked to that MAC for its next connection."
    }

    $active = @(Invoke-RouterRest -Path 'ip/hotspot/active')
    $alreadyActive = $active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.user -eq $Command.hotspot_username } | Select-Object -First 1
    if ($alreadyActive) { return }

    $newUser = @{
      name = $Command.hotspot_username
      password = $Command.hotspot_password
      'mac-address' = $mac
      'limit-uptime' = "$($Command.duration_minutes)m"
      comment = "Jixels session $($Command.session_id)"
    }
    if ($user) {
      $encodedId = [Uri]::EscapeDataString([string]$user.'.id')
      Invoke-RouterRest -Path "ip/hotspot/user/$encodedId" -Method Patch -Body $newUser | Out-Null
    } else {
      Invoke-RouterRest -Path 'ip/hotspot/user' -Method Put -Body $newUser | Out-Null
    }
  } elseif ($Command.action -eq 'BLOCK') {
    $active = @(Invoke-RouterRest -Path 'ip/hotspot/active')
    foreach ($client in ($active | Where-Object { (Normalize-Mac $_.'mac-address') -eq $mac -and $_.user -eq $Command.hotspot_username })) {
      $encodedId = [Uri]::EscapeDataString([string]$client.'.id')
      Invoke-RouterRest -Path "ip/hotspot/active/$encodedId" -Method Delete | Out-Null
    }
    if ($user) {
      $encodedId = [Uri]::EscapeDataString([string]$user.'.id')
      Invoke-RouterRest -Path "ip/hotspot/user/$encodedId" -Method Delete | Out-Null
    }
  } else { throw "Unsupported router action: $($Command.action)" }
}

Write-Host 'Jixels MikroTik agent v2026.11.06-macgrant connected. Press Ctrl+C to stop.'
$lastCommandWarningAt = @{}
while ($true) {
  try {
    $routerOnline = Test-RouterReachable
    try { Send-AgentHeartbeat -RouterOnline $routerOnline }
    catch { Write-Warning "Could not report agent/router health: $($_.Exception.Message)" }
    $feed = Invoke-RestMethod -Uri $config.apiUrl -Method Get -Headers $agentHeaders -TimeoutSec 15
    if (-not $routerOnline) {
      Write-Warning 'RouterOS is unreachable; paid devices remain queued until the router reconnects.'
      Start-Sleep -Seconds 8
      continue
    }
    foreach ($command in $feed.commands) {
      try {
        Apply-Command $command
        $lastCommandWarningAt.Remove([string]$command.id)
        $ack = @{ commandId = $command.id; ok = $true } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null
        Write-Host "Applied $($command.action) for $($command.mac_address)."
      } catch {
        $errorMessage = $_.Exception.Message
        # A paid ALLOW waits until RouterOS sees the same device again; a
        # temporary hotspot disconnect must not cancel a confirmed purchase.
        $isPermanent = $errorMessage -like '*PERMANENT_ROUTER_ERROR:*'
        $ack = @{ commandId = $command.id; ok = $false; permanent = $isPermanent; message = $errorMessage } | ConvertTo-Json -Compress
        try { Invoke-RestMethod -Uri $config.apiUrl -Method Post -Headers $agentHeaders -ContentType 'application/json' -Body $ack -TimeoutSec 15 | Out-Null } catch { }
        if ($isPermanent) { Write-Warning "Command $($command.id) stopped: $errorMessage" }
        else {
          $lastWarning = $lastCommandWarningAt[[string]$command.id]
          if (-not $lastWarning -or ([DateTimeOffset]::UtcNow - $lastWarning).TotalSeconds -ge 60) {
            Write-Warning "Command $($command.id) is waiting for this device to reconnect; it will retry. $errorMessage"
            $lastCommandWarningAt[[string]$command.id] = [DateTimeOffset]::UtcNow
          }
        }
      }
    }
  } catch {
    $statusCode = 0
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { }
    if ($statusCode -eq 400) {
      Write-Warning 'The deployed agent API rejected the request. Check that this agent and /api/mikrotik-agent/commands are from the same deployment version.'
    }
    if ($statusCode -eq 401) {
      Write-Warning 'Vercel rejected this agent before any RouterOS command ran. Check that Production has WIFI_GATEWAY_MODE=mikrotik-agent, MIKROTIK_AGENT_TOKEN exactly matches this PC, MIKROTIK_CREDENTIAL_SECRET is set, and MIKROTIK_HOTSPOT_LOGIN_URL is a private router login URL. Restart the agent after correcting Vercel settings.'
      break
    }
    Write-Warning "MikroTik agent poll failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 8
}
