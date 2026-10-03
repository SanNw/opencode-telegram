// Node 22+: CHROME_BINARY=/absolute/path/to/chrome npm run test:browser
// Real Chromium, built assets, isolated mock API. Never contacts production.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/mini-app/dist');
const chrome = process.env.CHROME_BINARY || process.argv[2];
assert.ok(chrome, 'Set CHROME_BINARY or pass an absolute Chromium executable path as the first argument');
assert.equal(typeof WebSocket, 'function', 'Browser verification requires Node.js 22 or newer');
await fs.access(chrome);
await fs.access(path.join(dist, 'index.html'));
const outputDirectory = path.join(root, 'test-results/browser');
await fs.mkdir(outputDirectory, { recursive: true });
await fs.rm(path.join(outputDirectory, 'evidence.json'), { force: true });
await fs.rm(path.join(outputDirectory, 'failure.json'), { force: true });
let revoked = false, configured = false, privileged = false, privilegedExpiresAt = 0, clockOffset = 0;
const fixtureNow = () => Math.floor((Date.now() + clockOffset) / 1000);
const calls = [], failures = [], evidence = [];
const artifact = { id: `att_${'a'.repeat(32)}`, name: 'browser-proof.md', mime: 'text/markdown', size: 30, preview: 'text', sessionId: 's1', createdAt: 1, category: 'documents' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: url.pathname, method: req.method, body });
    if (url.pathname.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': mock connected\n\n'); return; }
    const json = (data, status = 200) => {
      if (data.mutability) data.mcpServers = ['connected', 'needs_auth', 'disabled'].map((status, i) => ({ name: i === 0 ? 'Long-MCP-server-name-'.repeat(12) : `Fixture MCP ${i}`, status, enabled: status !== 'disabled', configType: 'local' }));
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
    };
    if (revoked && !url.pathname.includes('/auth/') && !url.pathname.endsWith('/recovery/unlock')) return json({}, 401);
    if (url.pathname.endsWith('/auth/telegram')) return json({});
    if (url.pathname.endsWith('/snapshot')) return json({ online: true, version: 'browser-fixture', syncedAt: new Date().toISOString(), projects: [{ id: 'p1', name: 'Fixture project', worktree: '/mock', updatedAt: Date.now() }], sessions: [{ id: 's1', projectId: 'p1', title: 'Long browser conversation', directory: '/mock', updatedAt: Date.now() }], statuses: { s1: 'idle' } });
    if (url.pathname.endsWith('/sessions/s1/messages')) return json({ messages: [{ id: 'm1', role: 'assistant', createdAt: Date.now(), completedAt: Date.now(), text: 'Long token: ' + 'verylongtoken'.repeat(40) + '\n\n```js\nconst longLine = "' + 'code'.repeat(120) + '";\n```\n\n| Column | Value |\n| --- | --- |\n| Long cell | ' + 'table'.repeat(80) + ' |\n\n' + Array.from({ length: 140 }, (_, i) => `Paragraph ${i + 1}: long-response browser fixture with **Markdown** and operational text.`).join('\n\n') }], permissions: [], todos: [] });
    if (url.pathname.endsWith('/sessions/s1/diff')) return json({ files: [] });
    if (url.pathname.endsWith('/capabilities')) return json({ version: 1, capabilities: {} });
    if (url.pathname.endsWith('/catalog')) return json({ providers: ['Local fixture', 'Router fixture'].map((name, provider) => ({ id: `provider-${provider}`, name, connected: true, models: Array.from({ length: 10 }, (_, i) => ({ id: `model-${i}`, name: i === 0 ? 'Very long model name '.repeat(15) : `Fixture Model ${i}`, status: 'active', limits: { context: 4096, output: 1024 }, variants: ['low', 'medium', 'high'] })) })), skills: [], plugins: [], mcpServers: [] });
    if (url.pathname.endsWith('/agents')) return json({ agents: [] });
    if (url.pathname.endsWith('/devices')) return json({ devices: [] });
    if (url.pathname.endsWith('/audit')) return json({ events: [] });
    if (url.pathname.endsWith('/usage')) return json({ totals: { messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, daily: [], breakdown: {}, collection: { running: false, failed: false, lastSyncedAt: null } });
    if (url.pathname.endsWith('/management')) return json({ mutability: { skills: { reason: 'Read-only fixture' }, plugins: { reason: 'Read-only fixture' }, mcp: { reason: 'Runtime fixture' }, providers: { reason: 'Official API fixture' } }, skills: [], skillSources: [], plugins: [], mcpServers: [], integrations: [], providers: ['OpenAI', 'Fixture Provider'].map((name, i) => ({ id: i ? 'fixture' : 'openai', name, connected: false, methods: [{ type: 'api', label: 'API key', supported: true }] })) });
    if (url.pathname.endsWith('/providers/openai/actions')) return json({}, 403);
    if (url.pathname.endsWith('/vcs/diff')) return json({ files: [] });
    if (url.pathname.endsWith('/vcs')) return json({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, files: [], commits: [] });
    if (url.pathname.endsWith('/artifacts')) return json({ artifacts: url.searchParams.get('category') === 'images' ? [] : [artifact] });
    if (url.pathname.includes('/attachments/')) { res.writeHead(200, { 'content-type': 'text/markdown' }); return res.end('# Isolated browser artifact'); }
    if (url.pathname.endsWith('/security/recovery/setup')) { configured = true; return json({ recoveryKey: 'rk_BROWSER_FIXTURE_NOT_A_REAL_SECRET' }); }
    if (url.pathname.endsWith('/security/step-up')) { privileged = true; privilegedExpiresAt = fixtureNow() + 300; return json({ expiresAt: privilegedExpiresAt }); }
    if (url.pathname.endsWith('/security/lock')) { if (!privileged || privilegedExpiresAt <= fixtureNow()) return json({}, 403); revoked = true; return json({ recoveryConfigured: configured, locked: true, telegramCompromised: false }); }
    if (url.pathname.endsWith('/security/recovery/unlock')) { revoked = false; return json({ deviceId: 'recovered-browser-fixture' }); }
    if (url.pathname.endsWith('/security')) return json({ recoveryConfigured: configured, locked: revoked, telegramCompromised: false });
    return json({});
  }
  try {
    const filename = url.pathname.startsWith('/assets/') ? path.join(dist, path.basename(path.dirname(url.pathname)), path.basename(url.pathname)) : path.join(dist, 'index.html');
    let data = await fs.readFile(filename);
    const ext = path.extname(filename);
    if (ext === '.html') data = Buffer.from(data.toString().replace(/<script src="https:\/\/telegram[^>]*><\/script>/, ''));
    res.writeHead(200, { 'content-type': ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/html' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-browser-proof-'));
const browser = spawn(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; browser.stderr.on('data', chunk => { stderr += chunk; });
browser.on('error', error => { stderr += error.message; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, captureFailure;
try {
  for (let i = 0; i < 100 && !stderr.includes('DevTools listening on'); i++) await pause(100);
  const wsURL = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  assert.ok(wsURL, `Browser startup failed: ${stderr.slice(-500)}`);
  socket = new WebSocket(wsURL); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map();
  socket.onmessage = event => { const data = JSON.parse(event.data); if (data.id) { const p = pending.get(data.id); clearTimeout(p?.timer); pending.delete(data.id); data.error ? p?.reject(new Error(data.error.message)) : p?.resolve(data.result); } if (data.method === 'Runtime.exceptionThrown') failures.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text); };
  socket.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser connection closed')); } pending.clear(); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.Telegram={WebApp:{initData:"isolated-fixture",platform:"browser",ready(){},expand(){},close(){}}};' });
  const evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const wait = async (expression, attempts = 80) => { for (let i = 0; i < attempts; i++) { if (await evaluate(expression)) return; await pause(100); } throw new Error(`Timed out: ${expression}; DOM=${await evaluate('document.body?.innerText')}; exceptions=${JSON.stringify(failures)}; API=${calls.map(c=>c.path).join(',')}`); };
  const click = async label => { await wait(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled&&b.getClientRects().length)`); await evaluate(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled&&b.getClientRects().length);b.focus();b.click()})()`); await pause(160); };
  const viewport = async (width, height, mobile) => { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await pause(160); };
  const text = text => `Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`;
  const screenshot = async name => { const { data } = await cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(outputDirectory, `browser-${name}.png`), Buffer.from(data, 'base64')); };
  captureFailure = () => screenshot('failure');
  const geometry = async name => { await wait("Array.from(document.querySelectorAll('nav')).some(n=>getComputedStyle(n).display!=='none')"); const value = await evaluate(`(()=>{const n=Array.from(document.querySelectorAll('nav')).find(n=>getComputedStyle(n).display!=='none');const r=n.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,navBottom:r.bottom,navTop:r.top,position:getComputedStyle(n).position}})()`); assert.ok(value.scrollWidth <= value.width + 1, `${name}: horizontal overflow ${JSON.stringify(value)}`); assert.ok(value.navBottom <= value.height + 1 && value.navTop >= 0, `${name}: nav outside viewport`); evidence.push({ check: name, ...value }); };
  await viewport(390, 844, true); await cdp('Page.navigate', { url: origin }); await wait(text('Fixture project'));
  await geometry('mobile initial navigation');
  await evaluate('window.scrollTo(0,document.body.scrollHeight)'); await geometry('mobile navigation after page scroll');
  await screenshot('mobile-home');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reduced = await evaluate("(()=>{const s=getComputedStyle(document.querySelector('.page.active')),b=getComputedStyle(document.querySelector('nav button'));return {animation:s.animationName,transition:b.transitionDuration}})()");
  assert.equal(reduced.animation, 'none'); assert.equal(reduced.transition, '0s');
  evidence.push({ check: 'reduced motion disables surface animations and interaction transitions', passed: true });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  for (const width of [320, 360, 700]) {
    await viewport(width, 844, true);
    for (const label of ['Home', 'Projects', 'Agents', 'Settings']) { await click(label); await geometry(`${label} at ${width}px`); }
  }
  await viewport(390, 844, true); await click('Home');
  await click('Projects'); await click('Artifacts'); await wait(text('browser-proof.md')); await click('Preview'); await wait(text('Isolated browser artifact'));
  for (let index = 0; index < 6; index++) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); assert.ok(await evaluate("Boolean(document.activeElement.closest('[role=dialog]'))"), 'Modal focus escaped on Tab'); }
  await click('Close'); assert.equal(await evaluate('document.activeElement.textContent.trim()'), 'Preview');
  await click('Images'); await wait(text('No images yet')); evidence.push({ check: 'artifact preview, modal Tab containment/focus restore, empty filter', passed: true });
  await click('Git'); await wait(text('Upstream: origin/main')); evidence.push({ check: 'Git metadata and diff', passed: true });
  await click('Open'); await wait(text('Paragraph 140:')); await viewport(390, 470, true);
  const openModels = async () => { await evaluate("document.querySelector('[aria-label=\"Choose model\"]').click()"); await wait("!document.getElementById('model-selector').hidden"); await pause(240); };
  await openModels();
  assert.equal(await evaluate("document.activeElement.type"), 'search');
  const searchModels = async value => { await evaluate(`(()=>{const e=document.querySelector('.model-menu input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`); await pause(100); };
  await searchModels('ROUTER FIXTURE'); assert.equal(await evaluate("document.querySelectorAll('.model-option').length"), 10);
  await searchModels('not-a-model'); assert.ok(await evaluate(text('No models found.')));
  await searchModels('');
  for (let i = 0; i < 20; i++) {
    await evaluate(`document.querySelectorAll('.model-option')[${i}].click()`); await wait("document.getElementById('model-selector').hidden");
    await openModels(); assert.equal(await evaluate(`document.querySelectorAll('.model-option')[${i}].getAttribute('aria-pressed')`), 'true');
  }
  for (const width of [320, 390, 700, 1280]) {
    await viewport(width, 700, width <= 700);
    const menu = await evaluate("(()=>{const m=document.querySelector('.model-menu'),l=m.querySelector('.model-options'),h=m.querySelector('.model-menu__header'),r=m.getBoundingClientRect(),before=h.getBoundingClientRect().top;l.scrollTop=1000;return {left:r.left,right:r.right,width:innerWidth,client:m.clientWidth,scroll:m.scrollWidth,listClient:l.clientWidth,listScroll:l.scrollWidth,scrolls:l.scrollHeight>l.clientHeight,headerFixed:before===h.getBoundingClientRect().top}})()");
    assert.ok(menu.left>=0 && menu.right<=menu.width && menu.scroll<=menu.client && menu.listScroll<=menu.listClient && menu.scrolls && menu.headerFixed, JSON.stringify(menu));
  }
  await evaluate("document.querySelector('[aria-label=\"Close model selector\"]').click()"); await wait("document.getElementById('model-selector').hidden");
  await openModels(); await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait("document.getElementById('model-selector').hidden");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), 'Choose model');
  await openModels(); await evaluate("document.querySelector('.tabs').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))"); await wait("document.getElementById('model-selector').hidden");
  evidence.push({ check: 'model selector: search, all 20 models selectable, active indicator, fixed header, narrow layouts, X, Escape and outside dismissal', passed: true });
  await viewport(390, 470, true);
  await evaluate("document.getElementById('prompt').focus()");
  const chatGeometry = await evaluate("(()=>{const c=document.querySelector('.composer').getBoundingClientRect(),s=document.querySelector('.conversation-stream');return {composerBottom:c.bottom,height:innerHeight,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight,documentWidth:document.documentElement.scrollWidth,width:innerWidth}})()");
  assert.ok(chatGeometry.composerBottom <= chatGeometry.height + 1); assert.ok(chatGeometry.scrollHeight > chatGeometry.clientHeight); assert.ok(chatGeometry.documentWidth <= chatGeometry.width + 1); evidence.push({ check: 'long response independently scrolls; composer visible after keyboard-equivalent resize', ...chatGeometry }); await screenshot('mobile-chat-keyboard-equivalent');
  const chatBounds = await evaluate("Array.from(document.querySelectorAll('.chathead,.composer,.conversation-pills,.tabs')).map(e=>{const r=e.getBoundingClientRect();return {name:e.className,left:r.left,right:r.right}})");
  assert.ok(chatBounds.every(r=>r.left>=0 && r.right<=390), `Chat content clipped: ${JSON.stringify(chatBounds)}`);
  evidence.push({ check: 'chat header, chips, tabs and composer fit inside mobile viewport', passed: true });
  for (const width of [320, 390, 700, 1280]) {
    await viewport(width, 700, width <= 700);
    const bounds = await evaluate("(()=>{const s=document.querySelector('.conversation-stream');return {width:s.clientWidth,scrollWidth:s.scrollWidth,parts:Array.from(s.querySelectorAll('.message-parts>*,.code-block')).map(e=>{const r=e.getBoundingClientRect(),p=s.getBoundingClientRect();return {left:r.left-p.left,right:r.right-p.left}})}})()");
    assert.ok(bounds.scrollWidth <= bounds.width + 1, `Message overflow at ${width}px: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.parts.every(p=>p.left >= -1 && p.right <= bounds.width + 1), `Message part escaped at ${width}px`);
    evidence.push({ check: `long token, fenced code and Markdown table stay inside chat at ${width}px`, passed: true });
  }
  await evaluate("document.querySelector('[aria-label=\"Back to dashboard\"]').click()"); await viewport(390, 844, true);
  await click('Settings'); await click('Integrations'); await wait(text('Official API fixture'));
  for (const width of [320, 390, 1280]) {
    await viewport(width, 844, width <= 700);
    const layout = await evaluate("(()=>{const m=document.querySelector('.integration-manager'),next=m.nextElementSibling;return {width:innerWidth,scroll:document.documentElement.scrollWidth,gap:next.getBoundingClientRect().top-m.getBoundingClientRect().bottom,servers:m.querySelectorAll('.mcp-server').length}})()");
    assert.ok(layout.scroll<=layout.width+1 && layout.gap>=18 && layout.servers===3, JSON.stringify(layout));
  }
  await screenshot('integrations-mcp');
  evidence.push({ check: 'MCP cards with long names fit mobile/desktop and Plugins stays separated from Telegram/OpenCode', passed: true });
  await viewport(390, 844, true); await click('Connect');
  await evaluate("document.getElementById('provider-key').value='must-not-cross-providers';Array.from(document.querySelectorAll('.management-row')).find(r=>r.innerText.includes('Fixture Provider')).querySelector('button').click()");
  await wait(text('API key for Fixture Provider')); assert.equal(await evaluate("document.getElementById('provider-key').value"), '');
  await evaluate("Array.from(document.querySelectorAll('.management-row')).find(r=>r.innerText.includes('OpenAI')).querySelector('button').click()");
  await wait(text('API key for OpenAI')); evidence.push({ check: 'provider switch resets credential input', passed: true });
  await evaluate(`document.getElementById('provider-key').value='fixture-key';document.getElementById('provider-key').form.requestSubmit()`);
  await wait(text('Step-up authentication')); assert.equal(await evaluate("Boolean(document.getElementById('provider-key'))"), false); assert.equal(await evaluate("document.body.innerText.includes('fixture-key')"), false); evidence.push({ check: 'provider 403 routes to Security without retained input', passed: true });
  await click('Set up Recovery Key'); await wait(text('rk_BROWSER_FIXTURE_NOT_A_REAL_SECRET'));
  const blockedHome = await evaluate("(()=>{const b=Array.from(document.querySelectorAll('nav button')).find(b=>b.textContent.trim()==='Home'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...blockedHome, button: 'left', clickCount: 1 }); await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...blockedHome, button: 'left', clickCount: 1 });
  assert.ok(await evaluate(text('rk_BROWSER_FIXTURE_NOT_A_REAL_SECRET')), 'Recovery disclosure was lost by background navigation');
  evidence.push({ check: 'native Recovery modal blocks pointer navigation behind one-time key', passed: true });
  await click('I saved my key'); assert.equal(await evaluate(text('rk_BROWSER_FIXTURE_NOT_A_REAL_SECRET')), false);
  await evaluate("document.getElementById('step-up-key').value='rk_BROWSER_FIXTURE_NOT_A_REAL_SECRET';document.getElementById('step-up-key').form.requestSubmit()"); await wait(text('Privileged session:')); assert.equal(await evaluate("document.getElementById('step-up-key').value"), ''); assert.ok(privileged); evidence.push({ check: 'one-time recovery display and cleared step-up input', passed: true });
  assert.ok(privilegedExpiresAt - fixtureNow() <= 300 && privilegedExpiresAt - fixtureNow() > 295, 'Step-up fixture must use epoch seconds and a five-minute TTL');
  assert.match(await evaluate("document.querySelector('.security-center [role=status]').innerText"), /Privileged session: (5:00|4:5[0-9]) remaining/);
  // Advance the browser clock and the mock API clock together, not the host clock.
  clockOffset = 310000;
  await evaluate('window.fixtureNativeNow=Date.now;Date.now=()=>window.fixtureNativeNow()+310000');
  await wait(text('Privileged session expired.'));
  await click('Home'); await wait(text('Fixture project'));
  await click('Settings'); await click('Security'); await click('Lock remote access'); await click('Confirm lock');
  await wait(text('Step-up authentication required.'));
  assert.equal(revoked, false, 'Expired privilege must not lock remote access');
  evidence.push({ check: 'five-minute step-up expiry blocks a sensitive operation while ordinary navigation remains available (simulated clock)', passed: true });
  clockOffset = 0;
  await evaluate("Date.now=window.fixtureNativeNow;delete window.fixtureNativeNow;document.getElementById('step-up-key').value='rk_BROWSER_FIXTURE_NOT_A_REAL_SECRET';document.getElementById('step-up-key').form.requestSubmit()");
  await wait(text('Privileged session:'));
  await viewport(390, 470, true); await geometry('mobile keyboard-equivalent viewport resize');
  await screenshot('mobile-keyboard-equivalent');
  await evaluate("window.dispatchEvent(new Event('online'));document.dispatchEvent(new Event('visibilitychange'))"); await pause(300); assert.ok(calls.filter(c => c.path.endsWith('/snapshot')).length >= 2); evidence.push({ check: 'online/visibility lifecycle refresh', passed: true });
  await viewport(1280, 800, false); await click('Home'); await geometry('desktop navigation');
  await screenshot('desktop-home');
  await click('Settings'); await click('Security'); await click('Lock remote access'); await click('Confirm lock'); await wait(text('Remote access locked')); evidence.push({ check: 'lock revokes visible dashboard', passed: true });
  await evaluate("window.Telegram.WebApp.initData='';document.querySelector('.gate-recovery').open=true;document.getElementById('access-recovery-key').value='rk_BROWSER_FIXTURE_NOT_A_REAL_SECRET';document.getElementById('access-recovery-key').form.requestSubmit()");
  await wait(text('Fixture project'), 300); const recovery = calls.find(c => c.path.endsWith('/recovery/unlock')); assert.ok(recovery.body.proof && recovery.body.publicKey); assert.equal('initData' in recovery.body, false); assert.equal(await evaluate("JSON.stringify(localStorage).includes('rk_BROWSER_FIXTURE')"), false); evidence.push({ check: 'recovery signed with new P-256 key without Telegram initData', passed: true });
  revoked = true;
  await evaluate("window.dispatchEvent(new Event('online'))");
  await wait(text('Access unavailable'));
  assert.equal(await evaluate("Boolean(document.querySelector('nav'))"), false);
  assert.equal(await evaluate(text('Fixture project')), false);
  evidence.push({ check: 'a revoked or expired normal session (mock HTTP 401) removes protected dashboard content', passed: true });
  const output = { passed: evidence.length, evidence, runtimeExceptions: failures, limitations: ['Mock API validates browser integration, not real backend authorization.', 'Resize/event dispatch are lifecycle equivalents; physical Telegram Android/Desktop keyboard and suspension remain manual.', 'No real OpenCode inference, physical OS suspension, or Cloudflare reconnect is asserted by this script.'] };
  assert.equal(failures.length, 0, `Runtime exceptions: ${JSON.stringify(failures)}`);
  await fs.writeFile(path.join(outputDirectory, 'evidence.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  await captureFailure?.().catch(() => {});
  await fs.writeFile(path.join(outputDirectory, 'failure.json'), JSON.stringify({ error: String(error), evidence, runtimeExceptions: failures }, null, 2));
  throw error;
} finally {
  socket?.close(); browser.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  // Only this script's newly-created disposable browser profile is removed.
  await pause(200); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
