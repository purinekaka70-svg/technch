#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash tools/install-mikrotik-agent-linux.sh"
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required. Install Node.js, then run this script again."
  exit 1
fi
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 18 )); then echo "Node.js 18 or newer is required."; exit 1; fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_user="technch-agent"
install_dir="/opt/technch-mikrotik-agent"
config_dir="/etc/technch-mikrotik-agent"
api_default="https://technch-hotspot.vercel.app/api/mikrotik-agent/commands"

if ! id "$service_user" >/dev/null 2>&1; then
  useradd --system --home-dir "$install_dir" --shell /usr/sbin/nologin "$service_user"
fi
install -d -o root -g root -m 0755 "$install_dir"
install -d -o "$service_user" -g "$service_user" -m 0700 "$config_dir"
install -o root -g root -m 0644 "$repo_dir/tools/mikrotik-agent-linux.mjs" "$install_dir/mikrotik-agent.mjs"

read -r -p "MikroTik RouterOS URL [http://192.168.88.1]: " router_url
router_url="${router_url:-http://192.168.88.1}"
read -r -p "Dedicated RouterOS username: " router_username
read -r -s -p "RouterOS password: " router_password; echo
read -r -s -p "MikroTik agent token (same value stored in Vercel): " agent_token; echo
if [[ -z "$router_username" || -z "$router_password" || -z "$agent_token" ]]; then
  echo "RouterOS username, password, and agent token are required." >&2
  exit 1
fi

JIXELS_ROUTER_URL="$router_url" JIXELS_ROUTER_USERNAME="$router_username" \
JIXELS_ROUTER_PASSWORD="$router_password" JIXELS_AGENT_TOKEN="$agent_token" \
JIXELS_API_URL="$api_default" node --input-type=module <<'NODE' > "$config_dir/config.json"
const config = {
  routerUrl: process.env.JIXELS_ROUTER_URL,
  routerUsername: process.env.JIXELS_ROUTER_USERNAME,
  routerPassword: process.env.JIXELS_ROUTER_PASSWORD,
  agentToken: process.env.JIXELS_AGENT_TOKEN,
  apiUrl: process.env.JIXELS_API_URL
};
process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
NODE
chown "$service_user:$service_user" "$config_dir/config.json"
chmod 0600 "$config_dir/config.json"

cat > /etc/systemd/system/technch-mikrotik-agent.service <<'UNIT'
[Unit]
Description=Jixels MikroTik payment access agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=technch-agent
Group=technch-agent
Environment=JIXELS_AGENT_CONFIG=/etc/technch-mikrotik-agent/config.json
ExecStart=/usr/bin/node /opt/technch-mikrotik-agent/mikrotik-agent.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now technch-mikrotik-agent.service
echo "Installed and started. Check with: sudo systemctl status technch-mikrotik-agent"
echo "View logs with: sudo journalctl -u technch-mikrotik-agent -f"
