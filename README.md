# reeler

Pull an Instagram reel through a browser you are already logged into, reassemble it, transcribe it, and sample frames. The result is a folder you can study as text and stills instead of rewatching a video.

It does not log in for you and it does not bypass anything. It attaches over the Chrome DevTools Protocol (CDP) to a browser session **you** have already opened and authenticated, then captures the same media that session streams while playing the reel.

## Why CDP

Instagram serves reel video as range-requested DASH fragments behind a session. Rather than reverse-engineer that, reeler attaches to a real, logged-in browser, lets it play the reel, captures the media track URLs, and refetches each track in full through the same session. It then picks the best video track, muxes in audio if they are separate, and hands you a clean MP4.

## Requirements

- Node 18+
- `ffmpeg` and `ffprobe` on PATH
- A Chromium-based browser running with remote debugging enabled and logged into Instagram, e.g.:
  ```
  chrome --remote-debugging-port=9226 --user-data-dir="/path/to/a/profile"
  ```
- Optional, for transcription: Python with [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (`pip install faster-whisper`)

## Install

```
npm install
```

## Use

```
node reeler.mjs "https://www.instagram.com/reel/SHORTCODE/"
```

Options:

| Flag | Default | Meaning |
|---|---|---|
| `--out DIR` | `out/<shortcode>` | output folder |
| `--cdp URL` | `http://localhost:9226` | CDP endpoint of your logged-in browser |
| `--fps N` | `1` | frames sampled per second |
| `--model NAME` | `base` | faster-whisper model size |
| `--python PATH` | auto | python interpreter for transcription |
| `--no-transcribe` | off | skip audio transcription |

## Output

```
out/<shortcode>/
  reel.mp4         reassembled video + audio
  audio.wav        16k mono audio (when transcribing)
  transcript.txt   plain-text transcript
  frames/          f_01.jpg, f_02.jpg, ...
  meta.json        url, duration, caption, transcript
```

## Notes

- Respect Instagram's terms and copyright. Use this on content you have a right to study or own.
- If no media is captured, confirm the browser is the one running on `--cdp`, is logged in, and that the reel actually started playing.

## License

MIT
