#!/usr/bin/env node
// Runs on `npm install` (postinstall). Provisions the external tools tldw needs
// so a fresh clone works with no manual PATH setup:
//   - yt-dlp  : standalone binary downloaded into vendor/ (no Python needed)
//   - whisper : a local .venv with faster-whisper, for transcription
// ffmpeg/ffprobe are vendored by the ffmpeg-static / ffprobe-static deps already.
// Network or Python failures only warn; they never fail the install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === 'win32';
const vendor = path.join(here, 'vendor');

async function getYtDlp() {
  fs.mkdirSync(vendor, { recursive: true });
  const dest = path.join(vendor, isWin ? 'yt-dlp.exe' : 'yt-dlp');
  if (fs.existsSync(dest)) { console.log('yt-dlp: already present'); return; }
  const asset = isWin ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  console.log(`yt-dlp: downloading ${asset} ...`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  if (!isWin) fs.chmodSync(dest, 0o755);
  console.log(`yt-dlp: installed -> ${dest}`);
}

function systemPython() {
  for (const c of (isWin ? ['py', 'python', 'python3'] : ['python3', 'python'])) {
    if (spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0) return c;
  }
  return null;
}

function venvPython() {
  const v = path.join(here, '.venv');
  return isWin ? path.join(v, 'Scripts', 'python.exe') : path.join(v, 'bin', 'python');
}

function setupWhisper() {
  const py = venvPython();
  const hasModule = (p) => spawnSync(p,
    ['-c', "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('faster_whisper') else 1)"],
    { stdio: 'ignore' }).status === 0;
  if (fs.existsSync(py) && hasModule(py)) { console.log('whisper: venv ready'); return; }
  const sys = systemPython();
  if (!sys) {
    console.warn('whisper: no Python found — transcription disabled. Install Python 3.9+ and run `npm run setup` to enable it.');
    return;
  }
  if (!fs.existsSync(py)) {
    console.log('whisper: creating .venv ...');
    if (spawnSync(sys, ['-m', 'venv', path.join(here, '.venv')], { stdio: 'inherit' }).status !== 0) {
      console.warn('whisper: venv creation failed — transcription disabled.');
      return;
    }
  }
  console.log('whisper: installing faster-whisper (first run can take a few minutes) ...');
  spawnSync(py, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'], { stdio: 'inherit' });
  if (spawnSync(py, ['-m', 'pip', 'install', '--quiet', 'faster-whisper'], { stdio: 'inherit' }).status !== 0) {
    console.warn('whisper: pip install failed — transcription disabled.');
    return;
  }
  console.log('whisper: ready');
}

try { await getYtDlp(); }
catch (e) { console.warn(`yt-dlp: download failed — ${e.message}. Put yt-dlp on PATH or pass --ytdlp to use YouTube/TikTok.`); }
try { setupWhisper(); }
catch (e) { console.warn(`whisper: setup failed — ${e.message}.`); }
