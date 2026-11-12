# Technch- Hotspot

Responsive customer portal and serverless Wi-Fi billing application for Vercel. Firebase Authentication handles admin sign-in and Cloud Firestore stores all application data: packages, payments, customer sessions, portal contexts, devices, and router-agent records. No Supabase project or SQL migrations are required.

## Firebase CLI and admin setup

1. Install Node.js 22 LTS or newer stable, install the Firebase CLI, then run `firebase login` and `firebase use technch--hotspot` from this project directory. The `.firebaserc` file selects the Technch Firebase project.
2. In Firebase Console, enable Email/Password under Authentication, create your admin user, and add the deployed domain to Authorized domains. Create the default Firestore database in Native mode.
3. Create a Firebase service account and configure `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` in Vercel. The web app configuration is embedded in `/admin.html`; keep the service-account private key server-side. Set the Firebase `admin: true` custom claim for your admin UID by running `FIREBASE_ADMIN_UID=<uid> node tools/grant-firebase-admin.mjs` from a trusted computer with the service-account environment configured. Protected API routes verify this claim.
4. Deploy Firestore rules with `firebase deploy --only firestore:rules`, then run `node tools/seed-firestore-packages.mjs` once to add the starter plans. Package changes made in admin are stored in Firestore. Packages with payment or session history cannot be deleted; disable them to preserve records.
5. Deploy this folder to the `technch-yey9` Vercel project. Its production URL is `https://technch-yey9.vercel.app/`.

The admin portal is installable as a PWA from `/admin.html`. After signing in, use **Install app** in the left navigation. Dashboard API responses are never cached by the service worker; the app shell is cached so the admin page can open offline, while live management data still requires internet access.

## M-Pesa billing

Configure CloudPay in Vercel with `CLOUDPAY_CONSUMER_KEY`, `CLOUDPAY_CONSUMER_SECRET`, `CLOUDPAY_WEBHOOK_SECRET`, and an explicit `CLOUDPAY_ENV`. Use `sandbox` only with CloudPay sandbox credentials for test transactions; set `production` with production credentials for live payments. CloudPay OAuth and payment API calls use `https://www.pay.cloud.or.ke/api` for production and `https://www.pay.cloud.or.ke/sandbox/api` for sandbox. The API fails closed if the environment is unset or invalid instead of silently using the sandbox. In the CloudPay dashboard, set the payment webhook URL to `https://technch-yey9.vercel.app/api/cloudpay/webhook` and copy its signing secret into `CLOUDPAY_WEBHOOK_SECRET`. The browser does not decide price or payment state; only a valid signed CloudPay completion event for the exact amount starts a paid session. The legacy unsigned `/api/mpesa/callback` endpoint is retired; use only `/api/cloudpay/webhook`.

## Airtel 5G router captive portal

The supplied router screenshots identify the interface as `TYRAX3004H` (the device label also shows `TYR300`). The visible settings do not expose a captive-portal option, so the Airtel router cannot itself redirect guest Wi-Fi users to checkout. Website Filter and Port Forwarding do not provide captive-portal authentication. Do not expose router admin credentials in Vercel or the browser.

The Network Settings screenshot confirms the router's LAN admin address is `192.168.1.1` and DHCP leases range from `192.168.1.100` to `192.168.1.249`. The earlier `192.168.10.1` value is shown separately as the upstream Internet default gateway. Do not change the LAN or DHCP values to configure a captive portal. Vercel cannot directly reach private LAN addresses; the TYRAX option below uses a local PC agent for router API calls. The visible router firmware has no captive-portal redirect, so its local agent can allow/block a paid device but cannot force the payment page to pop up.

## MikroTik HotSpot gateway with Tenda access point

This is the supported path if you buy/use a MikroTik: Airtel LAN connects to the MikroTik WAN; the Tenda runs in AP/bridge mode with its DHCP server disabled and connects to a guest-side MikroTik LAN/bridge; guests join the Tenda's Technch- HOTSPOT SSID. Set the Tenda's wireless network name (SSID) to exactly Technch- HOTSPOT in its Wi-Fi settings. Airtel Wi-Fi must stay private for staff. Guest traffic must pass through the MikroTik HotSpot.

The MikroTik portal redirect pages are provided in `mikrotik/hotspot/login.html` and `mikrotik/hotspot/rlogin.html`. They target `technch-yey9.vercel.app`; upload them to the active HotSpot HTML directory as `login.html` and `rlogin.html`. RouterOS serves `rlogin.html` when it intercepts an unauthenticated request to an external website; `login.html` serves the router's `/login` route. Both pages forward RouterOS's `$(mac)` and `$(ip)` values to the Vercel portal; checkout never asks the customer to type a MAC. Add `technch-yey9.vercel.app` to the MikroTik HotSpot walled garden so the portal can load before authentication. Configure HotSpot login-by `http-pap`; the app's local agent creates a temporary RouterOS HotSpot user locked to the originating MAC and paid duration, and the customer's browser submits that one-time login after CloudPay confirms payment. Keep RouterOS management reachable only on the trusted LAN. Use RouterOS v7 REST over trusted HTTPS if available; if using HTTP, isolate it to the wired/trusted LAN and restrict it to the agent PC's IP.

In Vercel set:

* `WIFI_GATEWAY_MODE=mikrotik-agent`
* `MIKROTIK_GATEWAY_ID=main` (or another short ID, matching this site)
* `MIKROTIK_AGENT_TOKEN` to a random 32-byte token
* `MIKROTIK_CREDENTIAL_SECRET` to a separate random secret of at least 32 bytes
* `MIKROTIK_HOTSPOT_LOGIN_URL` to the private RouterOS HotSpot login URL, for example `http://192.168.88.1/login`
* The CloudPay values listed above, including the signed callback at `https://technch-yey9.vercel.app/api/cloudpay/webhook`

Configure the MikroTik environment variables in Vercel. Router records and agent heartbeats are stored in Firestore; no database migrations are required. On the always-on Windows PC connected to the MikroTik's trusted LAN, run PowerShell from this repository:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$AgentToken = [BitConverter]::ToString($b).Replace('-', '').ToLower()
Set-Clipboard $AgentToken
# Save this token in Vercel as MIKROTIK_AGENT_TOKEN, then generate a different secret:
$secretBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
$MikrotikCredentialSecret = [BitConverter]::ToString($secretBytes).Replace('-', '').ToLower()
# Save this separate value in Vercel as MIKROTIK_CREDENTIAL_SECRET.
./tools/setup-mikrotik-agent.ps1 -AgentToken $AgentToken -RouterUrl 'http://192.168.88.1'
./tools/mikrotik-agent.ps1
```

Use your MikroTik's actual address in both places. The setup script stores the RouterOS API credential encrypted for that Windows account. Create a dedicated RouterOS API account for the agent, enable REST (`www` or `www-ssl`), and limit it to hotspot user/active operations and the agent PC. The agent validates that MikroTik still sees the checkout IP and MAC together before it creates access. RouterOS `limit-uptime` removes the paid session at expiry; the agent also removes active sessions and temporary users when the expiry job runs. The app polls this agent through HTTPS; Vercel never connects to the private router address. Configure CloudPay and the MikroTik mode in Vercel, then redeploy.

To keep the agent running after sign-in, open PowerShell as the same Windows user that ran setup and run `./tools/install-mikrotik-agent-task.ps1`. The scheduled task restarts the agent after failures; the Windows account must remain signed in and the PC must stay powered on. Check Router Management in `/admin.html`: it reports agent contact and MikroTik reachability separately.

#### Run the agent on an always-on Linux device

To keep payment activation working while the Windows laptop is off, use a Raspberry Pi or mini PC running Linux, connected by Ethernet to the MikroTik LAN and kept powered on. The device also needs outbound internet access to Vercel. Because guest HotSpot clients are unauthenticated, add only this trusted agent device's MAC to a RouterOS HotSpot IP binding with `type=bypassed`; do not bypass guest devices. The MikroTik remains the HotSpot gateway and the Linux process only polls the Jixels API and manages paid HotSpot users.

Install Node.js 22 LTS or newer stable, copy/clone this project onto the Linux device, then from the project directory run `sudo bash tools/install-mikrotik-agent-linux.sh`. Enter the same `MIKROTIK_AGENT_TOKEN` configured in Vercel and the dedicated RouterOS REST username/password. The installer stores credentials in `/etc/technch-mikrotik-agent/config.json` with owner-only access and installs a systemd service that starts at boot and restarts after failures. Check it with `sudo systemctl status technch-mikrotik-agent` and view logs with `sudo journalctl -u technch-mikrotik-agent -f`. Stop the Windows scheduled task before starting the Linux agent so only one agent is polling the gateway.

#### RouterOS-native agent (experimental)

The experimental script at `mikrotik/agent/jixels-cloud-agent.rsc` polls Vercel once per run, adds or removes MAC-locked HotSpot users, and reports command results. It uses HTTPS certificate validation and requires RouterOS 7.20 or newer. This option runs work on the router CPU; on a hAP lite with high CPU load, use it only as a cautious trial. It is not the preferred always-on setup.

In WinBox/WebFig, open **System → Scripts**, create `jixels-cloud-agent`, set policies `read,write,policy,test`, replace the token placeholder in the file with the existing Vercel agent token, and paste the source. Stop the Windows scheduled task first. Check the router clock/certificate trust, then run once manually with `/system script run jixels-cloud-agent use-script-permissions`. Inspect `/log print where message~"Jixels agent"` and `/system resource print`. If the manual run succeeds and router performance stays normal, schedule it once a minute with `/system scheduler add name=jixels-cloud-agent interval=1m start-time=startup on-event="/system script run jixels-cloud-agent use-script-permissions" policy=read,write,policy,test`.

To stop the poller immediately, run `/system scheduler disable [find name="jixels-cloud-agent"]`. To remove it completely, remove the scheduler entry and script: `/system scheduler remove [find name="jixels-cloud-agent"]; /system script remove [find name="jixels-cloud-agent"]`. Rebooting the router does not remove saved scripts or schedules. If CPU rises or the router becomes unresponsive, disable the schedule; do not rely on a reboot to undo it. A router restart also interrupts HotSpot service while it reboots.

### Additional access point inventory

**Router Management** in `/admin.html` stores an inventory of Ethernet access points, wireless bridges, and repeater bridges in Firestore. Use AP/bridge mode with DHCP/NAT disabled on the additional device so customer traffic continues through the MikroTik. Router/NAT and independent captive-portal modes are not supported by this integration. Inventory status remains **Not verified** because the application does not probe ordinary access points. A recent agent heartbeat only means the local agent contacted Technch; it does not prove the MikroTik or an access point is reachable.

This MikroTik path requires the Tenda to be an access point behind the MikroTik. A Tenda connected directly to Airtel, or left routing with its own DHCP, bypasses the HotSpot gateway. Phone tethering through an already-authorized device cannot be reliably blocked by MAC-based HotSpot control.

## OpenNDS hotspot gateway

Keep the Airtel unit as the 5G Internet source and add a separate gateway/access point that supports OpenWrt and openNDS. Connect Airtel LAN to the new gateway's WAN; have customer devices join the new gateway's Wi-Fi, which must be the default gateway for their traffic. Keep the Airtel Wi-Fi private for administration or disable it for guests, so customers cannot bypass the hotspot. Do not flash custom firmware onto the Airtel unit unless its exact hardware revision is confirmed as supported.

The application includes an openNDS HTTPS FAS endpoint (`/api/opennds/fas`), validates the FAS level 4 gateway identity, obtains the client MAC from the gateway portal context (customers never type it), binds checkout to that client, and grants access only after the signed CloudPay webhook confirms the exact amount. The customer enters only the M-Pesa phone number. openNDS enforces each purchased duration on the gateway; the scheduled job updates Firestore session records.

For the openNDS option, configure these Vercel environment variables and redeploy:

* `OPENNDS_GATEWAY_NAME`: exact `gatewayname` configured in openNDS.
* `OPENNDS_FAS_KEY`: long random secret, shared only between Vercel and openNDS.
* `OPENNDS_FAS_URL=https://technch-yey9.vercel.app/api/opennds/fas`.

Configure openNDS for secure level 4, port 443, and path `/api/opennds/fas`, with the same gateway name and FAS key. The guest SSID must be broadcast by this openNDS gateway. Keep its WAN connected to Airtel LAN; don't expose guest access through the Airtel Wi-Fi. Do not put the FAS key in the browser or commit it.

**Network requirement:** the gateway must allow its clients and authmon process to reach the portal host over HTTPS before authentication. openNDS documentation also requires CDN FAS deployments to use an appropriate reachable FAS IP and add the FQDN to the walled garden. Vercel uses hosted/CDN infrastructure; confirm a stable/reachable IP and walled-garden behavior on the actual router before taking live payments. If that cannot be guaranteed, host the FAS endpoint on a server with a stable public IP and TLS certificate, while keeping the customer site and billing API reachable from that FAS host. The current Airtel TYRAX3004H does not show a captive portal or openNDS option, so its admin UI cannot perform this gateway role.

Reference: [openNDS HTTPS FAS documentation](https://github.com/openNDS/openNDS/blob/master/docs/source/fas.rst) and [official configuration options](https://github.com/openNDS/openNDS/blob/master/linux_openwrt/opennds/files/etc/config/opennds). Check the OpenWrt hardware support list for the exact gateway model before buying or flashing equipment.

## Existing TYRAX router local agent

The TYRAX3004H admin interface exposes a local device block/unblock API. The Windows PowerShell bridge in `tools/tyrax-agent.ps1` can issue local commands without putting the router password in Vercel, but TYRAX does not provide captive-portal redirection. It cannot provide the full billing-to-login flow described for openNDS or MikroTik.

In Vercel set `WIFI_GATEWAY_MODE=tyrax-agent` and `TYRAX_AGENT_TOKEN` to a fresh long random token. Generate one in Windows PowerShell with:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$AgentToken = [BitConverter]::ToString($b).Replace('-', '').ToLower()
Set-Clipboard $AgentToken
```

Paste that token into Vercel, redeploy, then in PowerShell from this repository run `./tools/setup-tyrax-agent.ps1 -AgentToken $AgentToken` and `./tools/tyrax-agent.ps1`. The setup script prompts for the TYRAX admin password and stores it encrypted for that Windows account; the password is never sent to Vercel. The PC must remain online. This bridge provides device allow/block control, **not a captive portal**; do not treat it as an automatic paywall.

## Expiry job

On Vercel Hobby, `vercel.json` invokes `/api/cron/expire-sessions` once daily at 00:00 UTC. Set a unique `CRON_SECRET`; openNDS enforces paid session timeouts locally. In TYRAX agent mode, the local agent also checks for expired sessions every eight seconds and blocks their MACs. Upgrade to Vercel Pro if you need the hosted cleanup job to run more frequently.
