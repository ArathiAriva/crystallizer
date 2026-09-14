"""Crystallizer backend — audio → piano notes via Spotify Basic Pitch."""

import json
import sqlite3
import tempfile
import os

from fastapi import FastAPI, UploadFile, File, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from pathlib import Path

import basic_pitch
from basic_pitch.inference import predict

app = FastAPI(title="Crystallizer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3030", "http://crystallizer.localhost"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- library storage (SQLite) ----
DB_PATH = os.environ.get("CRYSTALLIZER_DB", str(Path(__file__).parent.parent / "library.db"))


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


with db() as _c:
    _c.executescript("""
        CREATE TABLE IF NOT EXISTS songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            duration REAL NOT NULL,
            notes_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS practice_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
            accuracy REAL NOT NULL,
            notes_hit INTEGER NOT NULL,
            notes_total INTEGER NOT NULL,
            speed REAL NOT NULL DEFAULT 1.0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    """)


class SongIn(BaseModel):
    name: str
    duration: float
    notes: list[dict]


class SessionIn(BaseModel):
    accuracy: float
    notes_hit: int
    notes_total: int
    speed: float = 1.0


@app.post("/songs")
def create_song(song: SongIn):
    with db() as c:
        cur = c.execute(
            "INSERT INTO songs (name, duration, notes_json) VALUES (?, ?, ?)",
            (song.name, song.duration, json.dumps(song.notes)),
        )
        return {"id": cur.lastrowid}


@app.get("/songs")
def list_songs():
    with db() as c:
        rows = c.execute("""
            SELECT s.id, s.name, s.duration, s.created_at,
                   COUNT(p.id) AS sessions,
                   MAX(p.accuracy) AS best_accuracy,
                   (SELECT accuracy FROM practice_sessions
                    WHERE song_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_accuracy
            FROM songs s LEFT JOIN practice_sessions p ON p.song_id = s.id
            GROUP BY s.id ORDER BY s.created_at DESC
        """).fetchall()
        return [dict(r) for r in rows]


@app.get("/songs/{song_id}")
def get_song(song_id: int):
    with db() as c:
        row = c.execute("SELECT * FROM songs WHERE id = ?", (song_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Song not found")
        d = dict(row)
        d["notes"] = json.loads(d.pop("notes_json"))
        return d


@app.delete("/songs/{song_id}")
def delete_song(song_id: int):
    with db() as c:
        c.execute("DELETE FROM songs WHERE id = ?", (song_id,))
    return {"ok": True}


@app.post("/songs/{song_id}/sessions")
def add_session(song_id: int, s: SessionIn):
    with db() as c:
        if not c.execute("SELECT 1 FROM songs WHERE id = ?", (song_id,)).fetchone():
            raise HTTPException(404, "Song not found")
        c.execute(
            "INSERT INTO practice_sessions (song_id, accuracy, notes_hit, notes_total, speed) VALUES (?, ?, ?, ?, ?)",
            (song_id, s.accuracy, s.notes_hit, s.notes_total, s.speed),
        )
    return {"ok": True}


@app.get("/songs/{song_id}/sessions")
def list_sessions(song_id: int):
    with db() as c:
        rows = c.execute(
            "SELECT * FROM practice_sessions WHERE song_id = ? ORDER BY created_at DESC, id DESC LIMIT 50",
            (song_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# Use the ONNX model explicitly (works with onnxruntime, no TensorFlow needed)
_model_path = str(
    Path(basic_pitch.__file__).parent / "saved_models" / "icassp_2022" / "nmp.onnx"
)


def clean_notes(notes, min_duration=0.08, min_amplitude=0.15,
                low=21, high=108):
    """Drop ghost notes: too short, too quiet, or outside piano range."""
    out = []
    for n in notes:
        start, end, pitch, amplitude = n["start"], n["end"], n["pitch"], n["amplitude"]
        if end - start < min_duration:
            continue
        if amplitude < min_amplitude:
            continue
        if not (low <= pitch <= high):
            continue
        out.append(n)
    return out


def melody_only(notes, window=0.05):
    """Keep only the highest-pitched note among overlapping starts (top line)."""
    notes = sorted(notes, key=lambda n: n["start"])
    out = []
    i = 0
    while i < len(notes):
        group = [notes[i]]
        j = i + 1
        while j < len(notes) and notes[j]["start"] - notes[i]["start"] < window:
            group.append(notes[j])
            j += 1
        out.append(max(group, key=lambda n: n["pitch"]))
        i = j
    return out


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    melody: bool = Query(False, description="Keep only the top melody line"),
    sensitivity: float = Query(0.5, ge=0.1, le=0.9),
):
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        _, _, note_events = predict(
            tmp_path,
            _model_path,
            onset_threshold=sensitivity,
            frame_threshold=0.3,
            minimum_note_length=80,
        )
    finally:
        os.unlink(tmp_path)

    notes = [
        {
            "start": round(float(s), 3),
            "end": round(float(e), 3),
            "pitch": int(p),
            "amplitude": round(float(a), 3),
        }
        for s, e, p, a in [(n[0], n[1], n[2], n[3]) for n in note_events]
    ]
    notes = clean_notes(notes)
    if melody:
        notes = melody_only(notes)
    notes.sort(key=lambda n: n["start"])

    duration = max((n["end"] for n in notes), default=0.0)
    return {"notes": notes, "count": len(notes), "duration": round(duration, 3)}
