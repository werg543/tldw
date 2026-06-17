<h1 align="center">tldw</h1>
<p align="center"><em>too long; didn't watch.</em></p>
<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-3c873a.svg">
  <img alt="platforms" src="https://img.shields.io/badge/platforms-Instagram%20%C2%B7%20TikTok%20%C2%B7%20YouTube%20Shorts-7d5fff.svg">
  <img alt="no mcp" src="https://img.shields.io/badge/MCP-not%20required-lightgrey.svg">
</p>

Point it at a short-form post and get back something you can read instead of rewatch:

- **Video** (reel / Short / TikTok): a clean `video.mp4`, a `transcript.txt`, and sampled `frames/`.
- **Carousel** (image slides): each slide at full resolution, optionally OCR'd to text.
- **Optional review**: hand the result to an LLM and ask whether it is worth acting on.

It does not log in for you and bypasses nothing. It attaches over the Chrome DevTools Protocol (CDP) to a browser **you** have already opened and authenticated, then captures the same media that session streams.

## Prerequisites

Read this part. tldw assumes nothing about your machine beyond these.

- **Node 18+**.
- **`ffmpeg` and `ffprobe`** on your `PATH`.
- **For YouTube and TikTok: [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)** on `PATH` (`pip install yt-dlp`). Those platforms stream formats a browser capture cannot reassemble (YouTube uses UMP/SABR), so tldw shells out to yt-dlp, which handles them and needs no login for public posts. Override the command with `--ytdlp` or `TLDW_YTDLP` (e.g. `--ytdlp "python -m yt_dlp"`).
- **For Instagram: your own logged-in browser**, started with remote debugging on. tldw attaches to it; it does not launch or log into anything for you. Any Chromium browser works (Chrome, Edge, Brave, Opera):
  ```
  chrome --remote-debugging-port=9226 --user-data-dir="/path/to/a/profile"
  ```
  Log into Instagram in that browser. Point tldw at it with `--cdp http://localhost:<port>` (default `9226`, it is only a default, use whatever port you launched). YouTube and TikTok do not need this.
- **No MCP servers are required.** tldw talks to your browser over CDP and to yt-dlp as a subprocess. It does not depend on any Model Context Protocol setup.
- *Optional:* Python with [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) for transcripts; `tesseract` for carousel OCR; any LLM CLI for `--review`. Each is only needed for the feature that uses it, and tldw tells you when one is missing instead of failing silently.

## Install

```
npm install
```

## Quick start

```
node tldw.mjs "https://www.instagram.com/reel/SHORTCODE/"
node tldw.mjs "https://www.instagram.com/p/SHORTCODE/"      # auto: video or carousel
node tldw.mjs "https://www.tiktok.com/@user/video/123"
node tldw.mjs "https://www.youtube.com/shorts/ID"
```

## How it works

1. **Resolve** the URL to a platform and media type. An Instagram `/p/` link can be a single image, a carousel, or a video, so that case is detected at runtime. YouTube and TikTok video are fetched with **yt-dlp** and skip straight to step 5.
2. **Attach + capture** over CDP (Instagram): open the post, force playback, and collect the media responses (`video/*`, `audio/*`, `.mp4`, `videoplayback`) from the moment the page loads, polling until media actually streams.
3. **Refetch full:** strip range params (`bytestart`/`byteend`/`range`) and request `bytes=0-` to get whole files.
4. **Pick + mux** (video): `ffprobe` each track and keep the one matching the on-screen reel's duration so a preloaded neighbor cannot win, muxing in audio if it is a separate track.
5. **Frames:** `ffmpeg` samples N stills per second.
6. **Transcribe** (video): `ffmpeg` to 16k mono wav, faster-whisper to text.
7. **Carousel** instead walks the slides and saves each at full resolution; `--ocr` runs tesseract over them.
8. **Review** (optional): with `--review`, the extracted text is handed to an LLM with your lens, writing `review.md`.
9. **Write** the output folder and `meta.json`.

## The review step

`--review` asks an LLM whether the content is worth acting on, through a lens you supply:

```
node tldw.mjs "<url>" --review "usefulness for a fintech product team"
```

It writes `review.md` with three things: effectiveness (what is actually valuable), efficiency (effort to act on vs payoff), and the single best next action (or "skip"). The lens is yours, so the same tool serves any project without baking anyone's context into it. The LLM command is configurable with `--llm` or the `TLDW_LLM` env var; it defaults to `claude -p`. Review needs a transcript or OCR text, so pair it with `--ocr` on carousels.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--out DIR` | `out/<platform>_<id>` | output folder |
| `--cdp URL` | `http://localhost:9226` | CDP endpoint of your logged-in browser |
| `--fps N` | `1` | frames sampled per second (video) |
| `--model NAME` | `base` | faster-whisper model size |
| `--python PATH` | auto | python interpreter for transcription |
| `--ocr` | off | OCR carousel slides with tesseract |
| `--review "lens"` | off | review the result against your lens |
| `--llm "cmd"` | `claude -p` | LLM command used by `--review` |
| `--ytdlp "cmd"` | `yt-dlp` | command used to fetch YouTube/TikTok |
| `--no-transcribe` | off | skip audio transcription |

## Output

```
out/<platform>_<id>/
  video.mp4        reassembled video + audio        (video posts)
  audio.wav        16k mono audio                   (when transcribing)
  transcript.txt   plain-text transcript            (video posts)
  frames/          f_01.jpg, ...                    (video posts)
  slide_01.jpg ... full-resolution slides           (carousels)
  slides.txt       OCR text                          (carousels, --ocr)
  review.md        LLM review                        (--review)
  meta.json        url, platform, type, caption, transcript/text, review
```

## Platform status

- **Instagram** reels and posts (video and carousel) — verified, via the logged-in CDP browser.
- **YouTube Shorts** — verified, via yt-dlp.
- **TikTok** video — via yt-dlp, the same path as YouTube. TikTok image (photo) carousels fall back to the CDP browser.

## Be a good citizen

- Respect each platform's terms and copyright. Use this on content you have a right to study or own.
- These platforms rate-limit. If you pull many posts quickly you may hit a login wall and capture will stop, tldw will tell you when that happens. Slow down and let it recover.
- If nothing is captured, confirm the browser on `--cdp` is the logged-in one and that the post actually started playing.

## License

MIT
