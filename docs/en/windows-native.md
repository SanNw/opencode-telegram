# Native Windows — without WSL

This setup does not use Docker or systemd. Run everything in Windows PowerShell with Node.js 22 LTS or newer and Git for Windows installed. OpenCode documents native installation through npm, Scoop and Chocolatey, while recommending WSL for maximum compatibility: [official documentation](https://opencode.ai/docs/).

## 1. Preparation

Open a new PowerShell window after installing Node/Git, then run:

```powershell
node --version
npm.cmd --version
git --version
npm.cmd install -g opencode-ai
opencode --version
git clone https://github.com/SanNw/opencode-telegram.git
Set-Location opencode-telegram
npm.cmd ci
Copy-Item .env.example .env
notepad .env
```

Use `npm.cmd` to avoid the execution policy for `npm.ps1`. Do not globally disable PowerShell security policy. Do not run `npm ci` in the checkout used by your WSL installation: SQLite dependencies include OS-specific binaries.

## 2. Configuration

Set the token, owner ID and HTTPS URL in `.env` as described in the [general installation guide](installation.md). Replace the Linux path with an existing authorized Windows folder, using forward slashes:

```dotenv
OPENCODE_DIRECTORY=E:/Projects/My-project
OPENCODE_URL=http://127.0.0.1:4096
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=8787
BRIDGE_DATABASE_PATH=./data/bridge.sqlite
ALLOW_INSECURE_LOCAL_DEV=false
```

Do not put real credentials in this example or publish `.env`. Do not authorize an entire drive. Providers, agents and MCP servers configured in WSL OpenCode do not automatically appear in Windows OpenCode: configure the native installation actually queried by the Bridge.

## 3. Run

From the repository folder:

```powershell
npm.cmd run build
```

In the first terminal, open the authorized folder and start OpenCode:

```powershell
Set-Location 'E:\Projects\My-project'
opencode serve --hostname 127.0.0.1 --port 4096
```

In the second terminal, open the repository folder and start the Bridge:

```powershell
npm.cmd start
```

If OpenCode server authentication is configured, the corresponding `.env` credentials must match. Configure the HTTPS tunnel on Windows to forward only `http://localhost:8787`; do not expose ports 4096 or 5173. A Cloudflare connector installed in WSL is not automatically a Windows service.

Check availability only; this does not prove authentication or inference:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/v1/system/health
```

Configure the BotFather button, open the Mini App, pair the device and test a conversation. Store the Recovery Key outside Telegram.

## 4. Keep it running

Initially, keep both terminals open. For automatic startup at login, use Windows Task Scheduler with **two separate tasks**, the user account that configured OpenCode and explicit working directories. The Bridge task can run `node.exe` with argument `apps\bridge\dist\server.js`, starting in the repository folder. The OpenCode task must run the native binary with arguments `serve --hostname 127.0.0.1 --port 4096`, starting in the authorized folder. Configure restart on failure. Never put tokens or passwords in task arguments.

The tunnel needs its own process/service. Sleep, shutdown and network loss make the installation unavailable. Do not expose firewall ports as a substitute for the tunnel.

## Troubleshooting and validation

- `better-sqlite3` failure: verify Node 22+ x64 and install dependencies in a Windows-only folder. Do not copy Linux modules. If no compatible prebuilt binary exists, npm may require Windows C++ build tools.
- `git` not found: install Git for Windows and reopen the terminal.
- Symlink tests may require Developer Mode or suitable privileges; do not remove security tests to obtain a passing result.
- Error 1033: check the tunnel connector process; it does not prove a Mini App failure.
- Before updating, make protected backups of `.env` and the database as described in [Operations and backup](operations.md).

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run test:runtime
```

The runtime test creates and removes its own disposable build copy, ignores production credentials and checks database/startup/local HTTP behavior. Never point a tunnel at its test port. Native dependency/test validation is not physical acceptance of Telegram, Windows sleep or startup at login. Record OS, Telegram version, device and actual results.
