# Linux / WSL installation

For installation without WSL, follow [Native Windows (PowerShell)](windows-native.md). Do not share `node_modules` between operating systems.

## Preparation

Install Node.js 22+, Git and OpenCode. Run OpenCode and the Bridge in the same Linux/WSL environment. Telegram can access the interface from other operating systems, but this does not mean every installation host has been validated.

```bash
git clone https://github.com/SanNw/opencode-telegram.git
cd opencode-telegram
npm ci
cp .env.example .env
```

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather token; keep it private |
| `TELEGRAM_OWNER_ID` | Owner's numeric ID |
| `TELEGRAM_MINI_APP_URL` | Public HTTPS URL of the Mini App |
| `OPENCODE_DIRECTORY` | Absolute path to an authorized project folder, not an entire disk |
| `OPENCODE_URL` | Local server; default: `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` | Matching OpenCode credentials, if configured |

Never enable `ALLOW_INSECURE_LOCAL_DEV` on an installation exposed through a tunnel. Do not share `.env`, databases, backups, cookies or pairing codes.

## Run

Run `npm run build`. In one terminal, run `opencode serve --hostname 127.0.0.1 --port 4096`; in another, run `npm start` from the repository folder. The Bridge serves the API and Mini App on port 8787.

To check availability only: `curl http://127.0.0.1:8787/api/v1/system/health`. A health response does not prove authentication or model inference.

## HTTPS and Telegram

Configure an HTTPS tunnel or reverse proxy that forwards **only** `http://localhost:8787`. Do not expose OpenCode on port 4096 or Vite on port 5173. Use a domain and tunnel controlled by your installation.

In BotFather, set the menu button to the Mini App HTTPS URL. Open it from the button and enter the pairing code printed in the Bridge terminal. After pairing, test a message and its approval.

## Protection and maintenance

Set up the Recovery Key in Security and store it outside Telegram. Configure OpenCode permissions: Bridge approval does not replace the agent's tool permissions.

For a persistent service, adapt the paths and user in the examples under `deploy/systemd/`; they are not installed automatically. Back up before updating. See [Operations and backup](operations.md) and [Security](security.md).
