# Jixels RouterOS-native MikroTik payment agent for RouterOS 7.20+
# Paste this file's contents into System > Scripts > Add > Source.
# Replace the token placeholder before saving. Keep the token private.

:local apiUrl "https://technch-yey9.vercel.app/api/mikrotik-agent/commands"
:local agentToken "PASTE_THE_EXISTING_MIKROTIK_AGENT_TOKEN_HERE"
:local authHeader ("Authorization: Bearer " . $agentToken)
:local jsonHeaders ("Authorization: Bearer " . $agentToken . ",Content-Type: application/json")
:local feedResult

:onerror pollError in={
  :set feedResult [/tool/fetch url=$apiUrl http-method=get http-header-field=$authHeader check-certificate=yes output=user as-value]
} do={
  :log warning ("Jixels agent: command poll failed: " . $pollError)
  :return ""
}

:local feed [:deserialize from=json value=($feedResult->"data")]
:local heartbeatBody [:serialize to=json value={"type"="heartbeat";"routerOnline"=true}]
:onerror heartbeatError in={
  /tool/fetch url=$apiUrl http-method=post http-header-field=$jsonHeaders http-data=$heartbeatBody check-certificate=yes output=none
} do={
  :log warning ("Jixels agent: heartbeat failed: " . $heartbeatError)
}

:local commands ($feed->"commands")
:foreach command in=$commands do={
  :local commandId ($command->"id")
  :local action ($command->"action")
  :local username ($command->"hotspot_username")
  :local password ($command->"hotspot_password")
  :local mac [:toupper ($command->"mac_address")]
  :local operationError ""

  :onerror commandError in={
    :if ($action="ALLOW") do={
      :local isActive false
      :foreach activeId in=[/ip/hotspot/active/find where user=$username] do={
        :local activeMac [:toupper [/ip/hotspot/active/get $activeId mac-address]]
        :if ($activeMac=$mac) do={ :set isActive true }
      }
      :if ($isActive=false) do={
        :local userIds [/ip/hotspot/user/find where name=$username]
        :if ([:len $userIds] > 0) do={
          :local userId [:pick $userIds 0]
          /ip/hotspot/user/set $userId password=$password mac-address=$mac limit-uptime=(($command->"duration_minutes") . "m") comment=("Jixels session " . ($command->"session_id"))
        } else={
          /ip/hotspot/user/add name=$username password=$password mac-address=$mac limit-uptime=(($command->"duration_minutes") . "m") comment=("Jixels session " . ($command->"session_id"))
        }
      }
      :log info ("Jixels agent: applied ALLOW for " . $mac)
    } else={
      :if ($action="BLOCK") do={
        :foreach activeId in=[/ip/hotspot/active/find where user=$username] do={
          :local activeMac [:toupper [/ip/hotspot/active/get $activeId mac-address]]
          :if ($activeMac=$mac) do={ /ip/hotspot/active/remove $activeId }
        }
        :foreach userId in=[/ip/hotspot/user/find where name=$username] do={
          :local userMac [:toupper [/ip/hotspot/user/get $userId mac-address]]
          :if ($userMac=$mac) do={ /ip/hotspot/user/remove $userId }
        }
        :log info ("Jixels agent: applied BLOCK for " . $mac)
      } else={
        :error ("Unsupported Jixels action: " . $action)
      }
    }
  } do={
    :set operationError $commandError
  }

  :if ([:len $operationError] = 0) do={
    :local ackBody [:serialize to=json value={"commandId"=$commandId;"ok"=true}]
    :onerror ackError in={
      /tool/fetch url=$apiUrl http-method=post http-header-field=$jsonHeaders http-data=$ackBody check-certificate=yes output=none
    } do={
      :log warning ("Jixels agent: success acknowledgement failed for " . $commandId . ": " . $ackError)
    }
  } else={
    :log warning ("Jixels agent: command " . $commandId . " will retry: " . $operationError)
    :local failBody [:serialize to=json value={"commandId"=$commandId;"ok"=false;"permanent"=false;"message"=$operationError}]
    :onerror failAckError in={
      /tool/fetch url=$apiUrl http-method=post http-header-field=$jsonHeaders http-data=$failBody check-certificate=yes output=none
    } do={
      :log warning ("Jixels agent: failure acknowledgement failed for " . $commandId . ": " . $failAckError)
    }
  }
}
