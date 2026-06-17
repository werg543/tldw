#!/usr/bin/env node
// reeler — pull an Instagram reel through an already-authenticated browser
// (via CDP), reassemble it, transcribe it, and sample frames so the content
// can be studied as text + stills.
import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const a = { fps: 1, cdp: 'http://localhost:9226', model: 'base', transcribe: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--cdp') a.cdp = argv[++i];
    else if (t === '--fps') a.fps = Number(argv[++i]);
    else if (t === '--model') a.model = argv[++i];
    else if (t === '--python') a.python = argv[++i];
    else if (t === '--no-transcribe') a.transcribe = false;
    else rest.push(t);
  }
  a.url = rest[0];
  return a;
}

function shortcode(url) {
  const m = url.match(/instagram\.com\/(?:reel|p|tv)\/([^/?#]+)/i);
  return m ? m[1] : 'reel';
}

function have(cmd) {
  const r = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  return r.status === 0 || r.status === 1;
}

function probe(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-show_entries',
      'format=duration,size:stream=codec_type', '-of', 'json', file
    ]).toString();
    const j = JSON.parse(out);
    const types = (j.streams || []).map((s) => s.codec_type);
    return {
      ok: true,
      size: Number(j.format?.size || fs.statSync(file).size),
      duration: Number(j.format?.duration || 0),
      hasVideo: types.includes('video'),
      hasAudio: types.includes('audio')
    };
  } catch {
    return { ok: false };
  }
}

async function grabTracks(url, cdp, dir) {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context on the CDP endpoint; is the authenticated browser running?');
  const page = await ctx.newPage();
  const bases = new Map(); // path -> first full url seen
  page.on('response', (r) => {
    const u = r.url();
    if (/\.mp4/.test(u)) {
      const base = u.split('?')[0];
      if (!bases.has(base)) bases.set(base, u);
    }
  });
  let caption = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.locator('video').first().click().catch(() => {});
    await page.waitForTimeout(3500);
    caption = (await page.locator('h1, article span[dir="auto"]').first().innerText().catch(() => '')).trim();
    const files = [];
    let i = 0;
    for (const [, full] of bases) {
      const clean = full.replace(/&?byte(start|end)=\d+/g, '');
      const resp = await ctx.request.get(clean, { headers: { Range: 'bytes=0-' } });
      if (!resp.ok() && resp.status() !== 206) continue;
      const buf = Buffer.from(await resp.body());
      if (buf.length < 1024) continue;
      const f = path.join(dir, `track${i}.mp4`);
      fs.writeFileSync(f, buf);
      files.push(f);
      i++;
    }
    return { files, caption };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function pickAndMux(files, dir) {
  const tracks = files.map((f) => ({ f, ...probe(f) })).filter((t) => t.ok);
  const video = tracks.filter((t) => t.hasVideo).sort((a, b) => b.size - a.size)[0];
  if (!video) throw new Error('no video track captured; the reel may not have started playing');
  const out = path.join(dir, 'reel.mp4');
  if (video.hasAudio) {
    fs.copyFileSync(video.f, out);
    return out;
  }
  const audio = tracks.filter((t) => t.hasAudio).sort((a, b) => b.size - a.size)[0];
  if (!audio) {
    fs.copyFileSync(video.f, out); // video-only reel
    return out;
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video.f, '-i', audio.f,
    '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', out]);
  return out;
}

function transcribe(wav, model, python) {
  const py = python || (spawnSync('python', ['--version'], { stdio: 'ignore' }).status === 0 ? 'python' : 'py');
  const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'transcribe.py');
  const r = spawnSync(py, [script, wav, model], { encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || '').trim() || 'transcription failed (is faster-whisper installed?)' };
  }
  return { ok: true, text: r.stdout.trim() };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.url || !/^https?:\/\/(www\.)?instagram\.com\//i.test(a.url)) {
    console.error('usage: reeler <instagram-reel-url> [--out DIR] [--cdp URL] [--fps N] [--model base] [--no-transcribe]');
    process.exit(2);
  }
  if (!have('ffmpeg') || !have('ffprobe')) {
    console.error('ffmpeg and ffprobe must be on PATH');
    process.exit(1);
  }
  const code = shortcode(a.url);
  const dir = path.resolve(a.out || path.join('out', code));
  fs.mkdirSync(dir, { recursive: true });

  console.log(`grabbing ${code} via ${a.cdp} ...`);
  const { files, caption } = await grabTracks(a.url, a.cdp, dir);
  if (!files.length) throw new Error('no media captured; check that the browser is logged in and the URL is correct');

  const reel = pickAndMux(files, dir);
  for (const f of files) if (f !== reel) fs.rmSync(f, { force: true });
  const meta = probe(reel);
  console.log(`reel.mp4 ready (${meta.duration?.toFixed(1)}s)`);

  const frames = path.join(dir, 'frames');
  fs.mkdirSync(frames, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', reel,
    '-vf', `fps=${a.fps}`, path.join(frames, 'f_%02d.jpg')]);
  const nFrames = fs.readdirSync(frames).length;
  console.log(`sampled ${nFrames} frames @ ${a.fps}fps`);

  let transcript = '';
  if (a.transcribe) {
    const wav = path.join(dir, 'audio.wav');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', reel, '-ar', '16000', '-ac', '1', wav]);
    const t = transcribe(wav, a.model, a.python);
    if (t.ok) {
      transcript = t.text;
      fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript + '\n');
      console.log('transcript.txt written');
    } else {
      console.warn('skipped transcription:', t.error);
    }
  }

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    url: a.url, shortcode: code, durationSec: meta.duration,
    caption, frames: nFrames, transcript
  }, null, 2));
  console.log(`done -> ${dir}`);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
