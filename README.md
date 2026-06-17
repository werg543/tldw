# tldw

*too long; didn't watch.*

Point it at a short-form post and get back something you can read instead of rewatch: a clean video with a transcript and sampled frames, or, for image carousels, the slides themselves (optionally OCR'd to text).

It works across **Instagram**, **TikTok**, and **YouTube Shorts**, and adapts to the post type (video vs image carousel).

It does not log in for you and bypasses nothing. It attaches over the Chrome DevTools Protocol (CDP) to a browser **you** have already opened and authenticated, then captures the same media that session streams.

## Why CDP

Short-form video is served as range-requested DASH fragments behind a session. Rather than reverse-engineer each platform, tldw attaches to a real, logged-in browser, lets the post load and play, captures the media track URLs by content type, and refetches each track in full through the same session. It then picks the best video track and muxes in audio if they are separate.

## How it works

1. **Resolve** the URL to a platform and media type. An Instagram `/p/` link can be a single image, a carousel, or a video, so that case is detected at runtime.
2. **Attach + capture** over CDP: open the post, start playback, and collect the media responses (`video/*`, `audio/*`, `.mp4`, `videoplayback`) from the moment the page loads.
3. **Refetch full:** strip range params (`bytestart`/`byteend`/`range`) and request `bytes=0-` to get whole files.
4. **Pick + mux** (video): `ffprobe` each track, take the largest video, mux in audio if it is a separate track.
5. **Frames:** `ffmpeg` samples N stills per second.
6. **Transcribe** (video): `ffmpeg` to 16k mono wav, faster-whisper to text.
7. **Carousel** instead saves each slide at full resolution, and with `--ocr` runs tesseract over them.
8. **Write** the output folder and a `meta.json` (url, platform, type, duration/slides, caption, transcript/text).

## Requirements

- Node 18+
- `ffmpeg` and `ffprobe` on PATH
- A Chromium-based browser running with remote debugging enabled and logged into the platform, e.g.:
  ```
  chrome --remote-debugging-port=9226 --user-data-dir="/path/to/a/profile"
  ```
- Optional: Python with [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) for transcripts; `tesseract` for carousel OCR

## Install

```
npm install
```

## Use

```
node tldw.mjs "https://www.instagram.com/reel/SHORTCODE/"
node tldw.mjs "https://www.instagram.com/p/SHORTCODE/"            # auto: video or carousel
node tldw.mjs "https://www.tiktok.com/@user/video/123"
node tldw.mjs "https://www.youtube.com/shorts/ID"
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--out DIR` | `out/<platform>_<id>` | output folder |
| `--cdp URL` | `http://localhost:9226` | CDP endpoint of your logged-in browser |
| `--fps N` | `1` | frames sampled per second (video) |
| `--model NAME` | `base` | faster-whisper model size |
| `--python PATH` | auto | python interpreter for transcription |
| `--ocr` | off | OCR carousel slides with tesseract |
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
  meta.json        url, platform, type, caption, transcript/text
```

## Platform status

- **Instagram** reels, posts (video and carousel) — verified.
- **TikTok** and **YouTube Shorts** — implemented via the same resolver and capture path. Verify against a live post in your session; the capture-then-refetch mechanic is shared, but platform DOM and CDN quirks may need small tweaks.

## Notes

- Respect each platform's terms and copyright. Use this on content you have a right to study or own.
- If nothing is captured, confirm the browser on `--cdp` is the logged-in one and that the post actually started playing.

## License

MIT
