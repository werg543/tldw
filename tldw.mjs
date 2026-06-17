#!/usr/bin/env node
// tldw — too long; didn't watch.
// Pull a short-form post (Instagram, TikTok, YouTube Shorts) through a browser
// you are already logged into (via CDP) and turn it into studyable text + stills.
// It does not log in for you and bypasses nothing; it rides your existing session.
import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const a = { fps: 1, cdp: 'http://localhost:9226', model: 'base', transcribe: true, ocr: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--cdp') a.cdp = argv[++i];
    else if (t === '--fps') a.fps = Number(argv[++i]);
    else if (t === '--model') a.model = argv[++i];
    else if (t === '--python') a.python = argv[++i];
    else if (t === '--no-transcribe') a.transcribe = false;
    else if (t === '--ocr') a.ocr = true;
    else if (t === '--review') { const n = argv[i + 1]; if (n && !n.startsWith('--')) { a.review = n; i++; } else a.review = ''; }
    else if (t === '--llm') a.llm = argv[++i];
    else if (t === '--ytdlp') a.ytdlp = argv[++i];
    else rest.push(t);
  }
  a.url = rest[0];
  return a;
}

// Detect platform, media type, and an id from the URL. type 'auto' is resolved
// at runtime (an Instagram /p/ can be a single image, a carousel, or a video).
function resolve(url) {
  let m;
  if ((m = url.match(/instagram\.com\/(?:reel|tv)\/([^/?#]+)/i))) return { platform: 'instagram', type: 'video', id: m[1] };
  if ((m = url.match(/instagram\.com\/p\/([^/?#]+)/i))) return { platform: 'instagram', type: 'auto', id: m[1] };
  if ((m = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/i))) return { platform: 'tiktok', type: 'video', id: m[1] };
  if ((m = url.match(/tiktok\.com\/t\/([^/?#]+)/i))) return { platform: 'tiktok', type: 'video', id: m[1] };
  if (/(?:vm|vt)\.tiktok\.com\//i.test(url)) return { platform: 'tiktok', type: 'video', id: 'tiktok' };
  if (/tiktok\.com\/.*\/photo\//i.test(url)) return { platform: 'tiktok', type: 'carousel', id: 'tiktok' };
  if ((m = url.match(/youtube\.com\/shorts\/([\w-]+)/i))) return { platform: 'youtube', type: 'video', id: m[1] };
  if ((m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/i))) return { platform: 'youtube', type: 'video', id: m[1] };
  return null;
}

function have(cmd) {
  const r = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
  return r.status === 0 || r.status === 1;
}

function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration,size:stream=codec_type', '-of', 'json', file]).toString();
    const j = JSON.parse(out);
    const types = (j.streams || []).map((s) => s.codec_type);
    return {
      ok: true,
      size: Number(j.format?.size || fs.statSync(file).size),
      duration: Number(j.format?.duration || 0),
      hasVideo: types.includes('video'),
      hasAudio: types.includes('audio')
    };
  } catch { return { ok: false }; }
}

async function openPage(ctx, url) {
  const page = await ctx.newPage();
  // collect media tracks from the moment the page starts loading, since the
  // first (and sometimes only) request for the media fires during page load.
  const media = new Map();
  page.on('response', (r) => {
    const ct = r.headers()['content-type'] || '';
    const u = r.url();
    if (ct.startsWith('video/') || ct.startsWith('audio/') || /\.mp4|videoplayback/.test(u)) {
      const base = u.split('?')[0];
      if (!media.has(base)) media.set(base, u);
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  // dismiss an Instagram login modal if present
  const close = page.locator('svg[aria-label="Close"]');
  if (await close.count().catch(() => 0)) { await close.first().click().catch(() => {}); await page.waitForTimeout(700); }
  page._media = media;
  return page;
}

async function readCaption(page, platform) {
  const sel = platform === 'youtube'
    ? 'h1, #title, yt-formatted-string'
    : 'h1, article span[dir="auto"], [data-e2e="browse-video-desc"]';
  return (await page.locator(sel).first().innerText().catch(() => '')).trim();
}

// Capture the post's media tracks by content-type, then refetch each in full.
// Live responses are often partial (DASH/range), so strip range params and ask
// for the whole file. Works across cdninstagram, tiktokcdn, and googlevideo.
function hasVideoTrack(bases) {
  for (const [base] of bases) if (/\.mp4|videoplayback/.test(base)) return true;
  return bases.size > 0;
}

async function grabVideo(ctx, page, dir) {
  const bases = page._media || new Map();
  await page.bringToFront().catch(() => {});
  // backgrounded/idle tabs throttle autoplay, so force playback and poll until
  // the media actually streams rather than waiting a fixed time and hoping.
  for (let tries = 0; tries < 8 && !hasVideoTrack(bases); tries++) {
    await page.locator('video').first().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await page.locator('video').first().click({ timeout: 2000 }).catch(() => {});
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) { v.muted = true; v.currentTime = 0; v.play().catch(() => {}); }
    }).catch(() => {});
    await page.waitForTimeout(1800);
  }
  console.log(`captured ${bases.size} media url(s)`);
  // the duration of the reel actually on screen, used to reject preloaded
  // neighbor reels that Instagram streams into the same page.
  const targetDuration = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v && isFinite(v.duration) ? v.duration : null;
  }).catch(() => null);
  const files = [];
  let i = 0;
  for (const [, full] of bases) {
    const clean = full.replace(/&(?:byte(?:start|end)|range)=[^&]*/g, '');
    const resp = await ctx.request.get(clean, { headers: { Range: 'bytes=0-' } });
    if (!resp.ok() && resp.status() !== 206) continue;
    const buf = Buffer.from(await resp.body());
    if (buf.length < 4096) continue;
    const f = path.join(dir, `track${i}.mp4`);
    fs.writeFileSync(f, buf);
    files.push(f);
    i++;
  }
  return { files, targetDuration };
}

// Pick the track matching the on-screen reel. When we know the displayed
// duration, prefer tracks within ~1.5s of it so a longer preloaded neighbor
// cannot win on size alone; otherwise fall back to largest.
function pickByDuration(tracks, targetDuration) {
  if (targetDuration) {
    const near = tracks.filter((t) => Math.abs(t.duration - targetDuration) <= 1.5);
    if (near.length) return near.sort((a, b) => b.size - a.size)[0];
  }
  return tracks.sort((a, b) => b.size - a.size)[0];
}

function muxBest(files, dir, targetDuration) {
  const tracks = files.map((f) => ({ f, ...probe(f) })).filter((t) => t.ok);
  const video = pickByDuration(tracks.filter((t) => t.hasVideo), targetDuration);
  if (!video) return null;
  const out = path.join(dir, 'video.mp4');
  if (video.hasVideo && video.hasAudio) { fs.copyFileSync(video.f, out); return out; }
  const audio = pickByDuration(tracks.filter((t) => t.hasAudio && t.f !== video.f), targetDuration);
  if (!audio) { fs.copyFileSync(video.f, out); return out; }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video.f, '-i', audio.f,
    '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', out]);
  return out;
}

// Walk a carousel, saving the highest-resolution image for each slide. Advances
// by clicking Next (revealed on hover) or pressing ArrowRight, and stops when
// the slide stops changing rather than trusting one selector to disappear.
async function grabCarousel(page, dir) {
  const slides = [];
  const seen = new Set();
  const biggestSrc = () => page.evaluate(() => {
    const imgs = [...document.querySelectorAll('article img, [data-e2e] img, img')];
    let best = null, area = 0;
    for (const im of imgs) { const a = im.naturalWidth * im.naturalHeight; if (a > area) { area = a; best = im; } }
    return best ? (best.currentSrc || best.src) : null;
  }).catch(() => null);

  let stale = 0;
  for (let step = 0; step < 25 && stale < 2; step++) {
    await page.waitForTimeout(500);
    const src = await biggestSrc();
    if (src && !seen.has(src)) {
      seen.add(src);
      stale = 0;
      const resp = await page.request.get(src).catch(() => null);
      if (resp && resp.ok()) {
        const f = path.join(dir, `slide_${String(slides.length + 1).padStart(2, '0')}.jpg`);
        fs.writeFileSync(f, Buffer.from(await resp.body()));
        slides.push(f);
      }
    } else { stale++; }
    await page.locator('article, main, section').first().hover().catch(() => {});
    const next = page.locator('button[aria-label="Next"], [aria-label="Next"], button:has(svg[aria-label="Next"])');
    if (await next.count().catch(() => 0)) await next.first().click().catch(() => {});
    else await page.keyboard.press('ArrowRight').catch(() => {});
  }
  return slides;
}

function transcribe(wav, model, python) {
  const py = python || (spawnSync('python', ['--version'], { stdio: 'ignore' }).status === 0 ? 'python' : 'py');
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const r = spawnSync(py, [path.join(here, 'transcribe.py'), wav, model], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || 'transcription failed (faster-whisper installed?)' };
  return { ok: true, text: r.stdout.trim() };
}

function ocr(imgs, dir) {
  if (!have('tesseract')) return { ok: false, error: 'tesseract not on PATH' };
  const parts = [];
  for (const img of imgs) {
    const r = spawnSync('tesseract', [img, 'stdout'], { encoding: 'utf8' });
    if (r.status === 0) parts.push(r.stdout.trim());
  }
  const text = parts.join('\n\n---\n\n').trim();
  fs.writeFileSync(path.join(dir, 'slides.txt'), text + '\n');
  return { ok: true, text };
}

// Optional review step: hand the extracted text to an LLM CLI and ask whether
// the content is worth acting on, through a caller-supplied lens. The command
// is configurable (env TLDW_LLM or --llm); it defaults to `claude -p` but the
// tool does not require it — review is off unless you pass --review.
function review(meta, dir, lens, llmArg) {
  const body = (meta.transcript || meta.text || '').trim();
  if (!body) return { ok: false, error: 'nothing textual to review (no transcript/OCR text; try --ocr for carousels)' };
  const prompt = [
    'Review this short-form social post for whether it is worth acting on.',
    `Lens: ${lens || 'general usefulness'}`,
    '',
    'Answer concisely:',
    '1. Effectiveness — what is genuinely valuable or insightful here, if anything.',
    '2. Efficiency — effort to act on vs the payoff.',
    '3. Action — the single best next step, or "skip" if not worth it.',
    '',
    `caption: ${meta.caption || '(none)'}`,
    `content: ${body}`
  ].join('\n');
  const cmd = (llmArg || process.env.TLDW_LLM || 'claude -p').split(' ');
  const r = spawnSync(cmd[0], [...cmd.slice(1), prompt], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `review command failed (${cmd[0]} not found?)` };
  return { ok: true, text: r.stdout.trim() };
}

// YouTube and TikTok serve formats the CDP refetch cannot reassemble (YouTube
// streams UMP/SABR with signed URLs), so use yt-dlp, which handles them and
// needs no login for public posts. Writes video.mp4 + video.info.json.
function grabWithYtdlp(url, dir, ytdlpArg) {
  const cmd = (ytdlpArg || process.env.TLDW_YTDLP || 'yt-dlp').split(' ');
  const out = path.join(dir, 'video.%(ext)s');
  // TikTok drops requests without a real browser UA; harmless for YouTube.
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const r = spawnSync(cmd[0], [...cmd.slice(1),
    '--no-playlist', '--no-warnings', '--write-info-json',
    '--user-agent', ua, '--retries', '3', '--socket-timeout', '20',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4',
    '-o', out, url], { encoding: 'utf8' });
  const file = path.join(dir, 'video.mp4');
  if (fs.existsSync(file)) return { ok: true, file };
  const err = (r.stderr || '').trim().split('\n').pop() || `yt-dlp failed (is it installed? tried "${cmd[0]}")`;
  return { ok: false, error: err };
}

function readYtInfo(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'video.info.json'), 'utf8'));
    return { title: j.title || '', description: j.description || '', duration: j.duration || null };
  } catch { return null; }
}

// Frames + transcript from a finished video.mp4, shared by every backend.
function processVideo(videoPath, dir, meta, a) {
  const p = probe(videoPath);
  meta.durationSec = meta.durationSec ?? p.duration;
  console.log(`video.mp4 ready (${(meta.durationSec ?? 0).toFixed?.(1) ?? meta.durationSec}s)`);
  const frames = path.join(dir, 'frames');
  fs.mkdirSync(frames, { recursive: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-vf', `fps=${a.fps}`, path.join(frames, 'f_%02d.jpg')]);
  meta.frames = fs.readdirSync(frames).length;
  console.log(`sampled ${meta.frames} frames @ ${a.fps}fps`);
  if (a.transcribe) {
    const wav = path.join(dir, 'audio.wav');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoPath, '-ar', '16000', '-ac', '1', wav]);
    const t = transcribe(wav, a.model, a.python);
    if (t.ok) { meta.transcript = t.text; fs.writeFileSync(path.join(dir, 'transcript.txt'), t.text + '\n'); console.log('transcript.txt written'); }
    else console.warn('skipped transcription:', t.error);
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const target = a.url && resolve(a.url);
  if (!target) {
    console.error('usage: tldw <url> [--out DIR] [--cdp URL] [--fps N] [--model base] [--ocr] [--review "lens"] [--llm "cmd"] [--no-transcribe]');
    console.error('supports: instagram.com/reel|p|tv, tiktok.com/@u/video|photo, youtube.com/shorts');
    process.exit(2);
  }
  if (!have('ffmpeg') || !have('ffprobe')) { console.error('ffmpeg and ffprobe must be on PATH'); process.exit(1); }

  const dir = path.resolve(a.out || path.join('out', `${target.platform}_${target.id}`));
  fs.mkdirSync(dir, { recursive: true });

  let meta = { url: a.url, platform: target.platform, id: target.id };

  // YouTube and TikTok video go through yt-dlp (public, no browser). Instagram,
  // and TikTok image carousels, go through the logged-in CDP browser.
  const viaYtdlp = (target.platform === 'youtube' || target.platform === 'tiktok') && target.type !== 'carousel';

  if (viaYtdlp) {
    console.log(`fetching ${target.platform}/${target.id} via yt-dlp ...`);
    const g = grabWithYtdlp(a.url, dir, a.ytdlp);
    if (!g.ok) throw new Error(g.error);
    meta.type = 'video';
    const info = readYtInfo(dir);
    if (info) { meta.caption = info.title; if (info.description) meta.description = info.description; meta.durationSec = info.duration; }
    processVideo(g.file, dir, meta, a);
  } else {
    const browser = await chromium.connectOverCDP(a.cdp);
    const ctx = browser.contexts()[0];
    if (!ctx) { console.error('no browser context on the CDP endpoint; is the authenticated browser running?'); process.exit(1); }
    try {
      console.log(`opening ${target.platform}/${target.id} ...`);
      const page = await openPage(ctx, a.url);

      const walled = await page.evaluate(() => {
        const t = document.body.innerText || '';
        const media = document.querySelectorAll('video, article img, img').length;
        return media === 0 && /log in|sign up|see this content|isn.?t available|create an account/i.test(t);
      }).catch(() => false);
      if (walled) throw new Error('post is behind a login wall — the browser on --cdp is not logged in to this platform (or has been rate-limited). Log in there, slow down, and retry.');

      meta.caption = await readCaption(page, target.platform);

      let type = target.type;
      if (type === 'auto') type = (await page.locator('video').count().catch(() => 0)) ? 'video' : 'carousel';
      meta.type = type;
      console.log(`type: ${type}`);

      if (type === 'video') {
        const { files, targetDuration } = await grabVideo(ctx, page, dir);
        const video = muxBest(files, dir, targetDuration);
        for (const f of files) if (f !== video) fs.rmSync(f, { force: true });
        if (!video) throw new Error('no video track captured — playback never streamed. The browser on --cdp may not be logged in, may be rate-limited, or the tab could not autoplay. Log in there, slow down, and retry.');
        processVideo(video, dir, meta, a);
      } else {
        const slides = await grabCarousel(page, dir);
        meta.slides = slides.length;
        console.log(`saved ${slides.length} slides`);
        if (a.ocr) {
          const o = ocr(slides, dir);
          if (o.ok) { meta.text = o.text; console.log('slides.txt written'); }
          else console.warn('skipped OCR:', o.error);
        }
      }
      await page.close().catch(() => {});
    } finally {
      await browser.close().catch(() => {});
    }
  }

  if (a.review !== undefined) {
    const r = review(meta, dir, a.review, a.llm);
    if (r.ok) { meta.review = r.text; fs.writeFileSync(path.join(dir, 'review.md'), r.text + '\n'); console.log('review.md written'); }
    else console.warn('skipped review:', r.error);
  }

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log(`done -> ${dir}`);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
