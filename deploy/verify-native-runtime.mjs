import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

// Copy only compiled application files, never .env, databases or credentials.
// Place the disposable root below this checkout so native dependencies resolve
// from its node_modules without copying or modifying their binaries.
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, 'test-results'), { recursive: true });
const isolated = await mkdtemp(join(root, 'test-results', 'native-runtime-'));
let child;
try {
  await cp(join(root, 'apps/bridge/dist'), join(isolated, 'apps/bridge/dist'), { recursive: true });
  await cp(join(root, 'apps/mini-app/dist'), join(isolated, 'apps/mini-app/dist'), { recursive: true });
  // npm may place the native addon in the workspace rather than hoist it.
  const workspaceModules = join(root, 'apps/bridge/node_modules');
  if (await access(workspaceModules).then(() => true, () => false)) {
    await cp(workspaceModules, join(isolated, 'apps/bridge/node_modules'), { recursive: true });
  }
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(TELEGRAM_|OPENCODE_|BRIDGE_|MANAGEMENT_|ALLOW_INSECURE_LOCAL_DEV$)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    ALLOW_INSECURE_LOCAL_DEV: 'true', BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: String(port),
    BRIDGE_DATABASE_PATH: join(isolated, 'data/smoke.sqlite'), OPENCODE_DIRECTORY: isolated,
    OPENCODE_URL: 'http://127.0.0.1:1',
  });
  child = spawn(process.execPath, [join(isolated, 'apps/bridge/dist/server.js')], { cwd: isolated, env, stdio: 'ignore' });
  // Handle spawn failures explicitly rather than leaving an unhandled event.
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Isolated Bridge exited: ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/v1/system/health`, { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, 'ok');
      healthy = true;
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(healthy, 'Isolated native Bridge did not become healthy');
  const page = await fetch(base, { signal: AbortSignal.timeout(2000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  console.log(JSON.stringify({ platform: process.platform, node: process.version, health: 'ok', staticUI: 200, isolated: true, limitations: 'No Telegram authentication, OpenCode inference or system-login/reboot validation.' }));
} finally {
  if (child && child.exitCode === null && child.pid) {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  await rm(isolated, { recursive: true, force: true });
}
