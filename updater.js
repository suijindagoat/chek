import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(childProcess.execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = 'suijindagoat/chek';
const BRANCH = process.env.CLIPKEY_UPDATE_BRANCH || 'main';
const INTERVAL_MS = Number(process.env.CLIPKEY_UPDATE_INTERVAL_MS || 5 * 60 * 1000);
const STATE_FILE = path.join(__dirname, '.github-update-state.json');

let busy = false;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'clipkey-updater',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function latestCommitSha() {
  const data = await fetchJson(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`);
  if (!data || !data.sha) throw new Error('GitHub response did not include a commit SHA.');
  return data.sha;
}

async function downloadZip(zipPath) {
  const res = await fetch(`https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`, {
    headers: { 'User-Agent': 'clipkey-updater' },
  });
  if (!res.ok) throw new Error(`GitHub ZIP download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(zipPath, bytes);
}

async function expandAndCopy(zipPath, tempDir) {
  await execFile('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      "$ErrorActionPreference='Stop'",
      `$zip=${JSON.stringify(zipPath)}`,
      `$tmp=${JSON.stringify(tempDir)}`,
      `$dest=${JSON.stringify(__dirname)}`,
      'Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force',
      '$src=(Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1).FullName',
      "Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force",
    ].join('; '),
  ], { cwd: __dirname });
}

async function npmInstall() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await execFile(npmCmd, ['install'], { cwd: __dirname });
}

async function restartMainApp() {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  await execFile(npxCmd, ['--yes', 'pm2@latest', 'restart', 'clipkey-flag'], { cwd: __dirname });
}

async function applyUpdate(sha) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipkey-update-'));
  const zipPath = path.join(tempRoot, 'chek.zip');
  try {
    console.log(`[updater] downloading ${REPO}@${BRANCH} ${sha.slice(0, 7)}`);
    await downloadZip(zipPath);
    await expandAndCopy(zipPath, path.join(tempRoot, 'extract'));
    await npmInstall();
    writeState({ lastSeenSha: sha, updatedAt: new Date().toISOString() });
    await restartMainApp();
    console.log('[updater] update applied and clipkey-flag restarted');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function checkOnce() {
  if (busy) return;
  busy = true;
  try {
    const sha = await latestCommitSha();
    const state = readState();
    if (!state.lastSeenSha) {
      writeState({ lastSeenSha: sha, updatedAt: new Date().toISOString() });
      console.log(`[updater] tracking ${REPO}@${BRANCH} ${sha.slice(0, 7)}`);
      return;
    }
    if (state.lastSeenSha === sha) {
      console.log(`[updater] no update (${sha.slice(0, 7)})`);
      return;
    }
    await applyUpdate(sha);
  } catch (e) {
    console.warn('[updater] check failed:', e && e.message ? e.message : e);
  } finally {
    busy = false;
  }
}

console.log(`[updater] watching ${REPO}@${BRANCH} every ${Math.round(INTERVAL_MS / 1000)}s`);
await checkOnce();
setInterval(checkOnce, INTERVAL_MS);
