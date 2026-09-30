// index.js â€” launches standalone Chromium (your installed Chrome) and wires up:
//   * Build with TinyMCE -> AI answer
//   * Ctrl+Shift+H key activation (key kept in MEMORY only -> re-entered each run)
//   * Ctrl+Shift+V quiz-password capture -> server, then paste
//
// The key is NOT saved to disk: every run starts unactivated, so you can change
// keys / handle expiry freely. The Chrome profile IS persistent so any extensions
// you install and your site logins stick around.
//
// All ClipKey server calls happen HERE in Node (no CORS limits).
// Usage:  npm install  then  npm start

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { WebSocket } from 'ws';


const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_DIRECTORY_URL = 'https://bnhserver.onrender.com';
const DEFAULT_SERVER_BASE_URLS = [
  'https://clipkey-server.vercel.app',
  'https://clipkey-server.onrender.com',
];
let discoveredServerBaseUrls = null;
let serverDiscoveryPromise = null;
const PROFILE_MODE = (process.env.CLIPKEY_PROFILE_MODE || 'default').toLowerCase();
const DEBUG_PORT = normalizeDebugPort(process.env.CLIPKEY_DEBUG_PORT || '0');
const ALLOW_FALLBACK_PROFILE = process.env.CLIPKEY_ALLOW_FALLBACK_PROFILE === '1';
const DEBUG_HOST = '127.0.0.1';

function normalizeDebugPort(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === '0') return '0';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? String(n) : '0';
}

// ---------- key state (in memory only; reset every run) ----------
const state = { apiKey: null, activated: false };

// ---------- chrome detection ----------
function resolveChromePath() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

// ---------- server calls (Node side, no CORS) ----------
async function fetchFromServers(pathname, options = {}) {
  let lastErr = null;
  for (const base of await getServerBaseUrls()) {
    try {
      const res = await fetchWithTimeout(base + pathname, options, 15000);
      if (res.ok) return res;
      lastErr = new Error(`${base}${pathname} -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All servers failed for ' + pathname);
}

async function getServerBaseUrls() {
  if (discoveredServerBaseUrls?.length) return discoveredServerBaseUrls;
  if (serverDiscoveryPromise) return serverDiscoveryPromise;

  serverDiscoveryPromise = fetch(SERVER_DIRECTORY_URL + '/api/servers')
    .then(async (res) => {
      if (!res.ok) throw new Error(`Server directory returned ${res.status}`);
      const data = await res.json();
      const urls = Array.isArray(data?.urls)
        ? data.urls.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
        : [];
      discoveredServerBaseUrls = [...new Set(urls)];
      return discoveredServerBaseUrls.length ? discoveredServerBaseUrls : DEFAULT_SERVER_BASE_URLS;
    })
    .catch((err) => {
      console.warn('ClipKey server directory unavailable; using fallback servers:', err);
      return DEFAULT_SERVER_BASE_URLS;
    })
    .finally(() => {
      serverDiscoveryPromise = null;
    });

  return serverDiscoveryPromise;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let DEVICE_ID = null;
function ensureDeviceId() {
  if (DEVICE_ID) return DEVICE_ID;
  const p = path.join(__dirname, '.device-id');
  try { if (fs.existsSync(p)) DEVICE_ID = fs.readFileSync(p, 'utf8').trim(); } catch {}
  if (!DEVICE_ID) {
    DEVICE_ID = 'dev-' + crypto.randomUUID();
    try { fs.writeFileSync(p, DEVICE_ID); } catch {}
  }
  return DEVICE_ID;
}

// Exposed: page asks "am I activated yet?" â€” gates the Ctrl+Shift+H popup and Ctrl+Shift+V.
function clipkeyIsActivated() {
  return state.activated && !!state.apiKey;
}

// Exposed: receives the key typed in the Ctrl+Shift+H popup.
// Always validates against the server's /api/activate, so any key format
// (bnhâ€¦, bcâ€¦, etc.) is accepted as long as the server says it's valid.
async function clipkeyActivateKey(rawKey) {
  rawKey = (rawKey || '').trim();
  if (!rawKey) return 'âš  Please enter a key.';
  // Keys must follow the bnh format.
  if (!rawKey.toLowerCase().startsWith('bnh')) return 'âŒ Invalid key format (must start with bnh).';
  const deviceId = ensureDeviceId();
  const activateAt = async (base) => {
    try {
      const res = await fetchWithTimeout(base + '/api/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: rawKey, deviceId }),
      }, 7000);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (res.ok && data && data.status === 'ok') {
        return { base, data };
      }
      const serverMessage =
        (data && (data.message || data.error || data.reason || data.status)) ||
        text ||
        ('HTTP ' + res.status);
      throw new Error(`${base}/api/activate -> ${res.status}: ${String(serverMessage).slice(0, 300)}`);
    } catch (e) {
      throw new Error(`${base}/api/activate -> ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    }
  };

  try {
    const result = await Promise.any((await getServerBaseUrls()).map(activateAt));
    state.apiKey = result.data.apiKey || rawKey;
    state.activated = true;
    console.log('Key activated via ' + result.base + '. type=' + (result.data.type || '?'));
    return 'âœ… Key Activated! Access granted.';
  } catch (e) {
    const messages = e && Array.isArray(e.errors) ? e.errors.map((err) => err.message) : [e.message];
    messages.forEach((message) => console.warn('Activation failed:', message));
    const lastMessage = messages[messages.length - 1] || 'all servers failed';
    if (/->\s*403\b/.test(messages.join('\n'))) {
      return 'âŒ Activation rejected by server: ' + lastMessage;
    }
    return 'âš  Could not activate key: ' + lastMessage;
  }
}

// Exposed: Ctrl+Shift+V â€” send captured clipboard text (e.g. quiz password) to the server.
async function clipkeySendPaste({ text = '', pageUrl = '', pageTitle = '' } = {}) {
  const t = String(text || '').trim();
  if (!t || !state.apiKey) return false;
  try {
    await fetchFromServers('/api/ctrl-shift-v-paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey, text: t, pageUrl, pageTitle }),
    });
    return true;
  } catch (e) {
    console.warn('ctrl-shift-v paste send failed:', e.message);
    return false;
  }
}

async function clipkeyBroadcast({ message = '' } = {}) {
  const text = String(message || '').trim();
  if (!text || !state.apiKey) return false;
  try {
    const res = await fetchFromServers('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey, message: text }),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.status === 'ok';
  } catch (e) {
    console.warn('broadcast failed:', e.message);
    return false;
  }
}

async function uploadBlobToTmpfiles(blob, name) {
  try {
    const form = new FormData();
    form.append('file', blob, name);
    const up = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form });
    const j = await up.json();
    let url = (j && j.data && j.data.url) || (j && j.url);
    if (url && url.includes('tmpfiles.org/') && !url.includes('/dl/')) {
      url = url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
    }
    return url || null;
  } catch (e) {
    console.warn('tmpfiles upload failed:', e.message);
    return null;
  }
}

async function uploadDataUrl(dataUrl, i) {
  try {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) return null;
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    const ext = (mime.split('/')[1] || 'png').split('+')[0];
    return await uploadBlobToTmpfiles(new Blob([buf], { type: mime }), `image_${i}.${ext}`);
  } catch (e) {
    console.warn('uploadDataUrl failed:', e.message);
    return null;
  }
}

// Exposed: the page asks Node for an answer.
async function clipkeyGetAnswer({ sentences = [], imageDatas = [], metadata = null }) {
  try {
    if (!state.apiKey) return 'âŒ No key yet â€” press Ctrl+Shift+H to enter your ClipKey key.';
    const apiKey = state.apiKey;

    const datas = Array.isArray(imageDatas) ? imageDatas.filter(Boolean) : [];

    // Image path -> /api/extension/upload. Match the extension payload shape:
    // one primary base64 imageData, plus imageDataList for every extracted image.
    if (datas.length) {
      const imageDataList = datas
        .map((data) => String(data || '').includes(',') ? String(data).split(',')[1] : String(data || ''))
        .filter(Boolean);
      const body = {
        sentences,
        apiKey,
        metadata,
        imageData: imageDataList[0],
        imageDataList,
      };
      try {
        const res = await fetchFromServers('/api/extension/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (j && j.answer) return j.answer;
      } catch (e) {
        console.warn('Upload route failed, falling back to text:', e.message);
      }
    }

    // Text path -> /ai
    const res = await fetchFromServers('/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: sentences.join(' '), apiKey, metadata }),
    });
    const j = await res.json();
    return (j && j.result && j.result.data) || 'âš  No answer returned';
  } catch (e) {
    console.error('clipkeyGetAnswer error:', e);
    return 'âš  Error contacting ClipKey server.';
  }
}

function resolveDefaultUserDataDir(chromePath) {
  const local = process.env.LOCALAPPDATA || '';
  if (!local) return null;
  const lower = String(chromePath || '').toLowerCase();
  if (lower.includes('\\microsoft\\edge\\')) return path.join(local, 'Microsoft\\Edge\\User Data');
  if (lower.includes('\\chrome beta\\')) return path.join(local, 'Google\\Chrome Beta\\User Data');
  return path.join(local, 'Google\\Chrome\\User Data');
}

function getDebugPortFromProfile(userDataDir) {
  if (!userDataDir) return null;
  try {
    const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
    const [port] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
    return normalizeDebugPort(port);
  } catch {
    return null;
  }
}

async function getDebugWebSocketUrlForPort(port) {
  try {
    const res = await fetch(`http://${DEBUG_HOST}:${port}/json/version`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function getDebugWebSocketUrl(userDataDir, extraPorts = []) {
  const ports = [];
  const addPort = (port) => {
    if (port && port !== '0' && !ports.includes(port)) ports.push(port);
  };
  for (const port of extraPorts) addPort(port);
  addPort(getDebugPortFromProfile(userDataDir));
  addPort(DEBUG_PORT);
  for (const port of ports) {
    const url = await getDebugWebSocketUrlForPort(port);
    if (url) return url;
  }
  return null;
}

function getChromeMajorVersion(chromePath) {
  try {
    const result = childProcess.spawnSync(chromePath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const text = `${result.stdout || ''} ${result.stderr || ''}`;
    const match = text.match(/(\d+)\./);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function blocksDefaultProfileDebugging(chromePath) {
  const lower = String(chromePath || '').toLowerCase();
  const isGoogleChrome = lower.includes('\\google\\chrome\\application\\chrome.exe');
  const major = getChromeMajorVersion(chromePath);
  return isGoogleChrome && major !== null && major >= 136;
}

function isBrowserProcessRunning(chromePath) {
  if (process.platform !== 'win32') return false;
  const imageName = path.basename(chromePath || '').toLowerCase();
  if (!imageName) return false;
  try {
    const out = childProcess.execFileSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.toLowerCase().includes(imageName);
  } catch {
    return false;
  }
}

function isProfileInUse(userDataDir) {
  if (!userDataDir) return false;
  const lockFile = path.join(userDataDir, 'SingletonLock');
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.closeSync(fd);
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  } catch (e) {
    return e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EBUSY');
  }
}

function profileInUseError(userDataDir) {
  return new Error(
    'Chrome profile is already in use: ' + userDataDir + '\n' +
    'Close the ClipKey/Chrome window that is using this profile, then run node index.js again.\n' +
    'If it is running under PM2, stop it first with: npm run pm2:stop'
  );
}

function findFreeDebugPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, DEBUG_HOST, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? String(address.port) : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('Could not reserve a free debug port.'));
      });
    });
  });
}

async function waitForDebugWebSocketUrl(userDataDir, timeoutMs = 15000, extraPorts = []) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = await getDebugWebSocketUrl(userDataDir, extraPorts);
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function launchChrome({ chromePath, userDataDir, debugPort = DEBUG_PORT }) {
  const effectiveDebugPort = debugPort === '0' ? await findFreeDebugPort() : debugPort;
  const args = [
    `--remote-debugging-port=${effectiveDebugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
    // Keep tabs/media running full-speed when you switch to other apps or
    // minimize Chrome (stops YouTube etc. from stalling in the background).
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
  if (userDataDir) args.splice(1, 0, `--user-data-dir=${userDataDir}`);
  const child = childProcess.spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return effectiveDebugPort;
}

function chromeLaunchArgs() {
  return [
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
    // Keep tabs/media running full-speed when you switch to other apps or
    // minimize Chrome (stops YouTube etc. from stalling in the background).
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
}

async function launchAutomatedChrome({ chromePath, userDataDir }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  // Keep the dedicated automated profile so site logins survive controller restarts.
  return puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    defaultViewport: null,
    userDataDir,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    args: chromeLaunchArgs(),
  });
}

async function connectOrLaunchChrome({ chromePath, userDataDir, debugUserDataDir, allowBundledFallback = false }) {
  if (userDataDir && DEBUG_PORT === '0') {
    const existingEndpoint = await getDebugWebSocketUrl(userDataDir);
    if (existingEndpoint) {
      console.log('Using already-running Chrome profile debugging endpoint.');
      return puppeteer.connect({ browserWSEndpoint: existingEndpoint, defaultViewport: null });
    }
    if (isProfileInUse(userDataDir)) throw profileInUseError(userDataDir);
    return launchAutomatedChrome({ chromePath, userDataDir });
  }

  let browserWSEndpoint = await getDebugWebSocketUrl(debugUserDataDir);
  if (!browserWSEndpoint) {
    if (!userDataDir && blocksDefaultProfileDebugging(chromePath)) {
      const automatedUserDataDir = path.join(__dirname, '.chrome-profile');
      console.warn('Google Chrome 136+ blocks debugging on the normal profile; launching one dedicated automated Chrome profile.');
      return launchAutomatedChrome({ chromePath, userDataDir: automatedUserDataDir });
    }
    if (!userDataDir && isBrowserProcessRunning(chromePath)) {
      throw new Error(
        'Your normal Chrome is already open without a reachable debugging endpoint. ' +
        'Close all Chrome windows, then start this again so it can launch your Chrome with debugging enabled.'
      );
    }
    const launchedDebugPort = await launchChrome({ chromePath, userDataDir });
    console.log('Debug port selected:', launchedDebugPort);
    browserWSEndpoint = await waitForDebugWebSocketUrl(debugUserDataDir, 15000, [launchedDebugPort]);
  }
  if (!browserWSEndpoint && allowBundledFallback && !userDataDir) {
    const fallbackUserDataDir = path.join(__dirname, '.chrome-profile');
    fs.mkdirSync(fallbackUserDataDir, { recursive: true });
    console.warn('Normal Chrome profile did not expose debugging; launching bundled automated profile instead.');
    const launchedDebugPort = await launchChrome({ chromePath, userDataDir: fallbackUserDataDir, debugPort: '0' });
    console.log('Debug port selected:', launchedDebugPort);
    browserWSEndpoint = await waitForDebugWebSocketUrl(fallbackUserDataDir, 15000, [launchedDebugPort]);
  }
  if (!browserWSEndpoint) {
    const profileHint = userDataDir
      ? 'Close the Chrome window for this profile, then start again.'
      : 'Close all normal Chrome windows, then start again so this can launch your Chrome with debugging enabled.';
    throw new Error('Could not connect to the Chrome debugging endpoint. ' + profileHint);
  }
  return puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
}

// ---------- live screen streaming (CDP screenshots -> server /ws/live-screen) ----------
// Starts after the key is activated. Captures the active browser TAB via Puppeteer/CDP,
// which never triggers the "you're sharing your screen" banner and does not clash with
// websites/extensions using getDisplayMedia.
const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const SCREEN_INITIAL_PHASE_MS = envMs('CLIPKEY_SCREEN_INITIAL_PHASE_MS', 10 * 60 * 1000);
const SCREEN_INITIAL_MIN_MS = envMs('CLIPKEY_SCREEN_INITIAL_MIN_MS', 4 * 1000);
const SCREEN_INITIAL_MAX_MS = envMs('CLIPKEY_SCREEN_INITIAL_MAX_MS', 8 * 1000);
const SCREEN_STEADY_MIN_MS = envMs('CLIPKEY_SCREEN_STEADY_MIN_MS', 5 * 60 * 1000);
const SCREEN_STEADY_MAX_MS = envMs('CLIPKEY_SCREEN_STEADY_MAX_MS', 10 * 60 * 1000);
const SCREEN_CAPTURE_TIMEOUT_MS = envMs('CLIPKEY_SCREEN_CAPTURE_TIMEOUT_MS', 10 * 1000);
const SCREEN_WS_CONNECT_TIMEOUT_MS = envMs('CLIPKEY_SCREEN_WS_CONNECT_TIMEOUT_MS', 8 * 1000);
const SCREEN_WS_AUTH_TIMEOUT_MS = envMs('CLIPKEY_SCREEN_WS_AUTH_TIMEOUT_MS', 8 * 1000);
const SCREEN_JPEG_QUALITY = Number(process.env.CLIPKEY_SCREEN_QUALITY || 55);

const withTimeout = (promise, timeoutMs, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);

const randBetween = (min, max) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
};
const wsUrlsFromBases = (bases) =>
  bases.map((b) => b.replace(/^http/i, 'ws') + '/ws/live-screen');

// Pick the page the user is actually looking at (visible, not blank), else any real page.
async function pickActivePage(browser) {
  const pages = await browser.pages().catch(() => []);
  let fallback = null;
  for (const p of pages) {
    try {
      const url = p.url();
      if (!url || url.startsWith('devtools://')) continue;
      if (!fallback) fallback = p;
      const visible = await p.evaluate(() => document.visibilityState === 'visible').catch(() => false);
      if (visible && url !== 'about:blank') return p;
    } catch {}
  }
  return fallback;
}

async function captureFrameBase64(browser) {
  const page = await pickActivePage(browser);
  if (!page) throw new Error('no capturable page found');
  try {
    return await withTimeout(
      page.screenshot({ type: 'jpeg', quality: SCREEN_JPEG_QUALITY, fullPage: false, encoding: 'base64' }),
      SCREEN_CAPTURE_TIMEOUT_MS,
      'screenshot timed out'
    );
  } catch (e) {
    throw new Error(e && e.message ? e.message : 'screenshot failed');
  }
}

function startScreenStreaming(browser) {
  let stopped = false;
  let ws = null;
  let authed = false;
  let startedAt = 0;
  let captureTimer = null;
  let heartbeatTimer = null;
  let captureInFlight = false;
  let frameCount = 0;
  let waitingForActivationLogged = false;

  const clearTimers = () => {
    if (captureTimer) { clearTimeout(captureTimer); captureTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  };

  const scheduleNextCapture = () => {
    if (stopped) return;
    const inInitial = Date.now() - startedAt < SCREEN_INITIAL_PHASE_MS;
    const min = inInitial ? SCREEN_INITIAL_MIN_MS : SCREEN_STEADY_MIN_MS;
    const max = inInitial ? SCREEN_INITIAL_MAX_MS : SCREEN_STEADY_MAX_MS;
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(doCapture, randBetween(min, max));
  };

  const doCapture = async () => {
    if (stopped || !authed || !ws || ws.readyState !== WebSocket.OPEN) {
      scheduleNextCapture();
      return;
    }
    if (captureInFlight) {
      scheduleNextCapture();
      return;
    }
    captureInFlight = true;
    try {
      const b64 = await captureFrameBase64(browser);
      if (b64 && ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'frame', image: 'data:image/jpeg;base64,' + b64, timestamp: Date.now() }));
          frameCount += 1;
          console.log(`Screen frame sent #${frameCount} (${Math.round(b64.length * 0.75 / 1024)} KB)`);
        } catch {}
      }
    } catch (e) {
      console.warn('Screen frame capture failed:', e && e.message ? e.message : e);
    } finally {
      captureInFlight = false;
      scheduleNextCapture();
    }
  };

  const tryConnect = (urls, i) => {
    if (stopped) return;
    if (i >= urls.length) { setTimeout(connect, 5000); return; } // all bases failed; retry later
    let opened = false;
    let authedThisSocket = false;
    let connectTimer = null;
    let authTimer = null;
    const sock = new WebSocket(urls[i]);
    ws = sock;
    authed = false;

    const clearSocketTimers = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (authTimer) { clearTimeout(authTimer); authTimer = null; }
    };

    const closeAndTryNext = (reason) => {
      if (stopped || ws !== sock) return;
      console.warn('Screen streaming connection fallback:', reason);
      clearSocketTimers();
      try { sock.close(); } catch {}
      setTimeout(() => {
        if (!stopped && ws === sock) tryConnect(urls, i + 1);
      }, 250);
    };

    console.log('Screen streaming connecting to ' + urls[i]);
    connectTimer = setTimeout(() => {
      if (!opened) closeAndTryNext('connect timed out');
    }, SCREEN_WS_CONNECT_TIMEOUT_MS);

    sock.on('open', () => {
      opened = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      try { sock.send(JSON.stringify({ type: 'auth', apiKey: state.apiKey, deviceId: ensureDeviceId() })); } catch {}
      authTimer = setTimeout(() => {
        if (!authedThisSocket) closeAndTryNext('auth timed out');
      }, SCREEN_WS_AUTH_TIMEOUT_MS);
    });
    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth_ok') {
        clearSocketTimers();
        clearTimers();
        authedThisSocket = true;
        authed = true;
        startedAt = Date.now();
        frameCount = 0;
        console.log('Screen streaming started (screenId ' + msg.screenId + ')');
        doCapture(); // Send the first frame immediately instead of waiting for the timer.
        heartbeatTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })); } catch {}
          }
        }, 30000);
      } else if (msg.type === 'error') {
        console.warn('Screen streaming rejected:', msg.message);
        closeAndTryNext(msg.message || 'server rejected auth');
      }
    });
    sock.on('close', () => {
      clearSocketTimers();
      clearTimers();
      if (ws === sock) ws = null;
      authed = false;
      if (stopped) return;
      if (authedThisSocket) setTimeout(connect, 5000); // streaming was live -> reconnect from the top
      else tryConnect(urls, i + 1);                    // no stream yet -> try next base now
    });
    sock.on('error', () => {
      if (!opened) closeAndTryNext('socket error');
    });
  };

  const connect = () => {
    if (stopped) return;
    if (!state.activated || !state.apiKey) {
      if (!waitingForActivationLogged) {
        waitingForActivationLogged = true;
        console.log('Screen streaming waiting for key activation.');
      }
      setTimeout(connect, 2000);
      return;
    } // wait for key
    waitingForActivationLogged = false;
    getServerBaseUrls()
      .then((bases) => {
        if (!stopped) tryConnect(wsUrlsFromBases(bases), 0);
      })
      .catch((err) => {
        console.warn('Screen streaming server discovery failed:', err);
        setTimeout(connect, 5000);
      });
  };

  connect();
  return () => { stopped = true; clearTimers(); try { ws && ws.close(); } catch {} };
}

// ---------- main ----------
(async () => {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.error('Could not auto-find Chrome or Edge. Please install Google Chrome.');
    process.exit(1);
  }

  const userDataDir = process.env.CLIPKEY_CHROME_USER_DATA_DIR || path.join(__dirname, '.chrome-profile');
  if (userDataDir) fs.mkdirSync(userDataDir, { recursive: true });
  const debugUserDataDir = userDataDir || resolveDefaultUserDataDir(chromePath);
  const injectSource = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');

  console.log('Chrome:  ', chromePath);
  console.log('Profile: ', userDataDir, '(persistent profile)');
  console.log('Debug:   ', DEBUG_PORT === '0' ? 'puppeteer launch' : DEBUG_HOST + ':' + DEBUG_PORT);
  console.log('Key:     ', 'not set yet â€” press Ctrl+Shift+H in the browser');

  const browser = await connectOrLaunchChrome({
    chromePath,
    userDataDir,
    debugUserDataDir,
    allowBundledFallback: ALLOW_FALLBACK_PROFILE,
  });

  const exposedFunctions = [
    ['clipkeyGetAnswer', clipkeyGetAnswer],
    ['clipkeyActivateKey', clipkeyActivateKey],
    ['clipkeyIsActivated', clipkeyIsActivated],
    ['clipkeySendPaste', clipkeySendPaste],
    ['clipkeyBroadcast', clipkeyBroadcast],
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForMainFrame = async (page, label = 'page') => {
    for (let i = 0; i < 40; i++) {
      try {
        page.mainFrame();
        return true;
      } catch (e) {
        if (!/main frame too early/i.test(e.message || '')) throw e;
        await sleep(250);
      }
    }
    console.warn('Timed out waiting for main frame:', label);
    return false;
  };
  const smokeTestBridge = async (page) => {
    try {
      return await page.evaluate(async () => {
        if (typeof window.clipkeyIsActivated !== 'function') {
          return { ok: false, error: 'clipkeyIsActivated is not a function' };
        }
        const result = await window.clipkeyIsActivated();
        return { ok: typeof result === 'boolean' };
      });
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  };
  const isClosedOrDetachedError = (e) =>
    /session closed|target closed|detached frame|frame was detached|execution context was destroyed/i.test(e?.message || String(e || ''));
  const safePageUrl = (page) => {
    try { return page.url(); } catch { return '<closed>'; }
  };

  const wirePage = async (page) => {
    if (!page || page.isClosed?.()) return false;
    const pageUrl = safePageUrl(page);
    if (!(await waitForMainFrame(page, pageUrl))) return false;
    if (page.isClosed?.()) return false;
    const hadInject = await page.evaluate(() => !!window.__clipkeyFlagInit).catch(() => false);
    const exposedNames = exposedFunctions.map(([name]) => name);
    for (const [name] of exposedFunctions) {
      try { if (typeof page.removeExposedFunction === 'function') await page.removeExposedFunction(name); }
      catch (e) {
        if (isClosedOrDetachedError(e) || page.isClosed?.()) return false;
        if (!/does not exist/i.test(e.message || '')) console.warn('Could not remove exposed function', name + ':', e.message);
      }
    }
    await page.evaluate((names) => {
      for (const name of names) {
        try { delete window[name]; } catch {}
        try { Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true }); } catch {}
        try { delete window[name]; } catch {}
      }
    }, exposedNames).catch(() => {});
    for (const [name, fn] of exposedFunctions) {
      try { await page.exposeFunction(name, fn); }
      catch (e) {
        if (isClosedOrDetachedError(e) || page.isClosed?.()) return false;
        console.warn('Could not expose function', name + ':', e.message);
      }
    }
    const exposedState = await page.evaluate((names) => Object.fromEntries(
      names.map((name) => [name, typeof window[name]])
    ), exposedNames).catch((e) => ({ error: e.message }));
    if (exposedState.error) {
      if (isClosedOrDetachedError(exposedState.error) || page.isClosed?.()) return false;
      throw new Error('ClipKey bridge check failed: ' + exposedState.error);
    }
    console.log('ClipKey page bridge:', JSON.stringify(exposedState), safePageUrl(page));
    const bridgeSmoke = await smokeTestBridge(page);
    if (!bridgeSmoke.ok) {
      if (isClosedOrDetachedError(bridgeSmoke.error) || page.isClosed?.()) return false;
      throw new Error('ClipKey bridge smoke failed: ' + (bridgeSmoke.error || JSON.stringify(bridgeSmoke)));
    }
    console.log('ClipKey bridge smoke: ok');
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.startsWith('[clipkey]')) console.log('  page>', t);
    });
    try { await page.evaluateOnNewDocument(injectSource); }
    catch (e) {
      if (isClosedOrDetachedError(e) || page.isClosed?.()) return false;
      console.warn('Could not install new-document script:', e.message);
    }
    if (hadInject) {
      await page.evaluate(() => { window.__clipkeyFlagInit = false; }).catch(() => {});
      console.log('Updated ClipKey script in existing tab:', safePageUrl(page));
    }
    try {
      await page.evaluate(injectSource);
      console.log('ClipKey injected:', safePageUrl(page));
    } catch (e) {
      if (isClosedOrDetachedError(e) || page.isClosed?.()) return false;
      throw e;
    }

    // TinyMCE answer editors live in same-origin child frames. Inject there
    // directly as well, so the command listener is installed in the frame's
    // own realm even when Moodle creates/replaces the iframe after page load.
    const injectChildFrame = async (frame) => {
      if (!frame || frame === page.mainFrame()) return;
      try {
        await frame.evaluate(injectSource);
      } catch (e) {
        if (!isClosedOrDetachedError(e) && !page.isClosed?.() && !/execution context|cross-origin|detached/i.test(e.message || '')) {
          console.warn('Could not inject ClipKey into child frame:', e.message);
        }
      }
    };
    for (const frame of page.frames()) await injectChildFrame(frame);
    page.on('frameattached', (frame) => { void injectChildFrame(frame); });
    page.on('framenavigated', (frame) => { void injectChildFrame(frame); });

    // Grant clipboard access for this page's origin so the Ctrl+Shift+V fallback
    // (navigator.clipboard.readText) works even when no native paste event fires.
    // Re-granted on every navigation since the origin can change.
    const grantClipboard = async () => {
      try {
        const origin = new URL(page.url()).origin;
        if (/^https?:/.test(origin)) {
          await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write']);
        }
      } catch {}
    };
    await grantClipboard();
    page.on('domcontentloaded', grantClipboard);
    return true;
  };

  const wireNewPageTargets = () => browser.on('targetcreated', async (target) => {
    try {
      if (target.type() === 'page') {
        const page = await target.page();
        if (page) await wirePage(page);
      }
    } catch (e) {
      console.warn('Could not wire new page:', e.message);
    }
  });

  const wireExistingPages = async () => {
    const pages = await browser.pages();
    if (!pages.length) pages.push(await browser.newPage());
    for (const page of pages) await wirePage(page);
  };

  await wireExistingPages();
  wireNewPageTargets();

  // Begins screenshotting the active tab once the key is activated (waits internally).
  const stopScreenStreaming = startScreenStreaming(browser);

  console.log('\nReady.');
  console.log('  1) Press Ctrl+Shift+H and enter your key (once per run).');
  console.log('  2) Browse to your quiz; use the TinyMCE branding click to answer.');
  console.log('  Ctrl+Z = undo (answer peels word-by-word; manual edits too); Ctrl+Y = redo.');
  console.log('  TinyMCE click answering starts ON. Ctrl+Alt+Shift+X toggles it.');
  console.log('  Extra helpers start OFF. Ctrl+Shift+C toggles Ctrl+Shift+V, Ctrl+Shift+X, left-click capture.');
  console.log('  When enabled: Ctrl+Shift+V = capture clipboard to server + paste.');
  console.log('  When enabled: Ctrl+Shift+X = activate key, broadcast "bc <message>", or answer selected/buffered text.');
  console.log('  When enabled: click "Question N" heading = toggle TinyMCE answer trigger on/off.');
  console.log('Close the browser window to exit.\n');

  browser.on('disconnected', () => {
    try { stopScreenStreaming(); } catch {}
    process.exit(0);
  });
})();
