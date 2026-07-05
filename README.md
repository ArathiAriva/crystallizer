# Crystallizer 🎹

Turn any piece of music into piano notes you can learn. Upload an audio file — or record a song playing nearby (e.g. from your phone) — and Crystallizer transcribes it and shows Synthesia-style falling notes over an on-screen keyboard.

Transcription uses [Spotify's Basic Pitch](https://github.com/spotify/basic-pitch) model (ONNX, runs locally, no API keys).

## Stack

- `backend/` — FastAPI + basic-pitch (port 8000)
- `frontend/` — Next.js + React, canvas renderer (port 3000)

## Setup

Backend:

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

Frontend (separate terminal):

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000.

## How to use

1. **Upload audio** (MP3/WAV/etc.) or press **Record** and play the song near your mic, then Stop.
2. Wait for transcription (a few seconds to ~a minute for long songs).
3. Press **Play**. Notes fall toward the yellow line; when a note reaches it, that's when you play it on your keyboard. Note letters are printed on each block.
4. Beginner tips: keep **Melody only** on and speed at 50%. Use **Loop** to drill a tricky phrase: press once at the start, again at the end.

## Library & practice

- After transcribing you're prompted to **save the song to your library** (SQLite, `backend/library.db`); or press **Save to library** later.
- The **Library** panel lists saved songs with per-song stats; **Open** loads one, ✕ deletes it and its practice history.
- **🎼 Sheet music** shows the song's notes on a grand staff (simplified rhythm, treble/bass split at middle C).
- **▶ Practice** listens through your mic while notes scroll: play along on a real instrument and correctly played notes turn green. When the song ends (or you press End practice), accuracy is saved and shown in **Practice history**, plus best/last accuracy in the library list.

## Notes & limits

- Solo piano recordings transcribe best. Full-band songs still work but expect some extra/missing notes — "Melody only" helps a lot.
- Mic recordings pick up room noise; get the phone close to the mic.
- YouTube: play the video out loud and use Record mode.
