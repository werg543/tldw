import sys
from faster_whisper import WhisperModel

wav = sys.argv[1]
model = sys.argv[2] if len(sys.argv) > 2 else "base"

m = WhisperModel(model, device="cpu", compute_type="int8")
segments, _ = m.transcribe(wav, language="en")
print(" ".join(s.text.strip() for s in segments).strip())
