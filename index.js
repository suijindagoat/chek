// index.js â€” launches standalone Chromium (your installed Chrome) and wires up:
//   * Flag question -> AI answer
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
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_BASE_URLS = [
  'https://clipkey-server.onrender.com',
  'https://clipkey-server.vercel.app',
];
const DEBUG_PORT = process.env.CLIPKEY_DEBUG_PORT || '0';
const DEBUG_HOST = '127.0.0.1';

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
  for (const base of SERVER_BASE_URLS) {
    try {
      const res = await fetch(base + pathname, options);
      if (res.ok) return res;
      lastErr = new Error(`${base}${pathname} -> ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All servers failed for ' + pathname);
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
  try {
    const res = await fetchFromServers('/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: rawKey, deviceId: ensureDeviceId() }),
    });
    const data = await res.json();
    if (data && data.status === 'ok') {
      state.apiKey = data.apiKey || rawKey;
      state.activated = true;
      console.log('Key activated. type=' + (data.type || '?'));
      return 'âœ… Key Activated! Access granted.';
    }
    return 'âŒ Invalid or expired key.';
  } catch (e) {
    console.warn('Activation error:', e.message);
    return 'âš  Could not reach the server. Try again.';
  }
}

// Exposed: Ctrl+Shift+X "bc <message>" -> POST /api/broadcast { apiKey, message }
async function clipkeyBroadcast(message) {
  const m = String(message || '').trim();
  if (!m) return 'Broadcast failed.';
  if (!state.apiKey) return 'Broadcast failed.';
  try {
    const res = await fetchFromServers('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey, message: m }),
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.status === 'ok') {
      console.log('Broadcast sent:', m);
      return 'Broadcast sent.';
    }
    return 'Broadcast failed.';
  } catch (e) {
    console.warn('Broadcast error:', e.message);
    return 'Broadcast failed.';
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

    // Image path -> /api/extension/upload (server supports multiple via imageUrls)
    if (datas.length) {
      const imageUrls = [];
      for (let i = 0; i < datas.length; i++) {
        const u = await uploadDataUrl(datas[i], i);
        if (u) imageUrls.push(u);
      }
      let body;
      if (imageUrls.length) {
        body = { sentences, apiKey, metadata, imageUrls, imageUrl: imageUrls[0] };
      } else {
        const b64 = datas[0].split(',')[1];
        body = { sentences, apiKey, metadata, imageData: b64 };
      }
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

function getDebugPortFromProfile(userDataDir) {
  if (DEBUG_PORT !== '0') return DEBUG_PORT;
  try {
    const activePortFile = path.join(userDataDir, 'DevToolsActivePort');
    const [port] = fs.readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
    return port || null;
  } catch {
    return null;
  }
}

async function getDebugWebSocketUrl(userDataDir) {
  try {
    const port = getDebugPortFromProfile(userDataDir);
    if (!port) return null;
    const res = await fetch(`http://${DEBUG_HOST}:${port}/json/version`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function waitForDebugWebSocketUrl(userDataDir, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = await getDebugWebSocketUrl(userDataDir);
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function connectOrLaunchChrome({ chromePath, userDataDir }) {
  let browserWSEndpoint = await getDebugWebSocketUrl(userDataDir);
  if (!browserWSEndpoint) {
    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      'about:blank',
    ];
    const child = childProcess.spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    browserWSEndpoint = await waitForDebugWebSocketUrl(userDataDir);
  }
  if (!browserWSEndpoint) {
    throw new Error('Could not connect to the Chrome debugging endpoint.');
  }
  return puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
}

// ---------- main ----------
(async () => {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.error('Could not auto-find Chrome or Edge. Please install Google Chrome.');
    process.exit(1);
  }

  const userDataDir = path.join(__dirname, '.chrome-profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  const injectSource = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');

  console.log('Chrome:  ', chromePath);
  console.log('Profile: ', userDataDir, '(persistent profile)');
  console.log('Key:     ', 'not set yet â€” press Ctrl+Shift+H in the browser');

  const browser = await connectOrLaunchChrome({ chromePath, userDataDir });

  const exposedFunctions = [
    ['clipkeyGetAnswer', clipkeyGetAnswer],
    ['clipkeyActivateKey', clipkeyActivateKey],
    ['clipkeyIsActivated', clipkeyIsActivated],
    ['clipkeySendPaste', clipkeySendPaste],
    ['clipkeyBroadcast', clipkeyBroadcast],
  ];
  const wirePage = async (page) => {
    const hadInject = await page.evaluate(() => !!window.__clipkeyFlagInit).catch(() => false);
    for (const [name] of exposedFunctions) {
      try { if (typeof page.removeExposedFunction === 'function') await page.removeExposedFunction(name); } catch {}
    }
    await page.evaluate((names) => {
      for (const name of names) {
        try { delete window[name]; } catch {}
      }
    }, exposedFunctions.map(([name]) => name)).catch(() => {});
    for (const [name, fn] of exposedFunctions) {
      try { await page.exposeFunction(name, fn); } catch {}
    }
    await page.evaluateOnNewDocument(injectSource);
    if (!hadInject) await page.evaluate(injectSource).catch(() => {});
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.startsWith('[clipkey]')) console.log('  page>', t);
    });

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
  };

  browser.on('targetcreated', async (target) => {
    if (target.type() === 'page') {
      const page = await target.page();
      if (page) await wirePage(page);
    }
  });

  const pages = await browser.pages();
  if (!pages.length) pages.push(await browser.newPage());
  for (const page of pages) await wirePage(page);

  console.log('\nReady.');
  console.log('  1) Press Ctrl+Shift+H and enter your key (once per run).');
  console.log('  2) Browse to your quiz; click "Flag question" for answers.');
  console.log('  Click "Question N" heading = toggle flag feature on/off.');
  console.log('  Ctrl+Shift+V = capture clipboard to server + paste.');
  console.log('  Ctrl+Shift+X = broadcast "bc <message>" to the server.');
  console.log('  Ctrl+Alt+Shift+X = toggle flag feature on/off.');
  console.log('Close the browser window to exit.\n');

  browser.on('disconnected', () => process.exit(0));
})();
