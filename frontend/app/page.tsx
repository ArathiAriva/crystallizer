"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SheetMusic from "./SheetMusic";

const API = "http://localhost:8030";

type Note = { start: number; end: number; pitch: number; amplitude: number };
type SongMeta = {
  id: number; name: string; duration: number; created_at: string;
  sessions: number; best_accuracy: number | null; last_accuracy: number | null;
};
type Session = {
  id: number; accuracy: number; notes_hit: number; notes_total: number;
  speed: number; created_at: string;
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (p: number) => NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1);
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [status, setStatus] = useState("Drop an audio file or record to get started.");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  const [melody, setMelody] = useState(true);
  const [recording, setRecording] = useState(false);
  const [loop, setLoop] = useState<{ a: number | null; b: number | null }>({ a: null, b: null });
  const [duration, setDuration] = useState(0);

  // library state
  const [songs, setSongs] = useState<SongMeta[]>([]);
  const [currentSongId, setCurrentSongId] = useState<number | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [showSheet, setShowSheet] = useState(false);

  // practice state
  const [practicing, setPracticing] = useState(false);
  const [liveHits, setLiveHits] = useState(0);

  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  const loopRef = useRef(loop);
  const notesRef = useRef<Note[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playedRef = useRef<Set<number>>(new Set());
  const lastFileRef = useRef<File | null>(null);
  const recStopRef = useRef<(() => void) | null>(null);

  const practicingRef = useRef(false);
  const hitsRef = useRef<Set<number>>(new Set());
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStopRef = useRef<(() => void) | null>(null);
  const pitchBufRef = useRef<Float32Array | null>(null);
  const currentSongIdRef = useRef<number | null>(null);

  speedRef.current = speed;
  loopRef.current = loop;
  notesRef.current = notes;
  currentSongIdRef.current = currentSongId;

  // ---- library API ----
  const loadSongs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/songs`);
      if (res.ok) setSongs(await res.json());
    } catch { /* backend down; library just stays empty */ }
  }, []);

  useEffect(() => { loadSongs(); }, [loadSongs]);

  async function loadSessions(songId: number) {
    try {
      const res = await fetch(`${API}/songs/${songId}/sessions`);
      if (res.ok) setSessions(await res.json());
    } catch { setSessions([]); }
  }

  async function saveToLibrary(noteData?: Note[], dur?: number, defaultName?: string) {
    const n = noteData ?? notes;
    if (!n.length) return;
    const name = window.prompt("Song name:", defaultName ?? "Untitled song");
    if (!name) return;
    const res = await fetch(`${API}/songs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, duration: dur ?? duration, notes: n }),
    });
    if (res.ok) {
      const { id } = await res.json();
      setCurrentSongId(id);
      setSessions([]);
      setStatus(`Saved "${name}" to library.`);
      loadSongs();
    } else {
      setStatus("Failed to save song — is the backend running?");
    }
  }

  async function loadSong(id: number) {
    stopPractice(false);
    const res = await fetch(`${API}/songs/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setNotes(data.notes);
    setDuration(data.duration);
    setCurrentSongId(id);
    timeRef.current = 0;
    playedRef.current.clear();
    setLoop({ a: null, b: null });
    playingRef.current = false;
    setPlaying(false);
    setStatus(`Loaded "${data.name}". Press Play to preview or Practice to play along.`);
    loadSessions(id);
  }

  async function deleteSong(id: number) {
    if (!window.confirm("Delete this song and its practice history?")) return;
    await fetch(`${API}/songs/${id}`, { method: "DELETE" });
    if (currentSongId === id) { setCurrentSongId(null); setSessions([]); }
    loadSongs();
  }

  // ---- audio synth ----
  function playTone(pitch: number, dur: number) {
    const ctx = (audioCtxRef.current ??= new AudioContext());
    const f = 440 * Math.pow(2, (pitch - 69) / 12);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + Math.max(dur, 0.3));
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + Math.max(dur, 0.3) + 0.05);
  }

  // ---- transcription ----
  async function transcribe(file: File) {
    lastFileRef.current = file;
    setBusy(true);
    setPlaying(false);
    playingRef.current = false;
    stopPractice(false);
    setStatus("Transcribing… this can take a moment.");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/transcribe?melody=${melody}`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setNotes(data.notes);
      setDuration(data.duration);
      setCurrentSongId(null);
      setSessions([]);
      timeRef.current = 0;
      playedRef.current.clear();
      setLoop({ a: null, b: null });
      setStatus(`${data.count} notes found (${data.duration.toFixed(1)}s).`);
      // offer to save right away
      await saveToLibrary(data.notes, data.duration, file.name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      setStatus(`Transcription failed: ${e}. Is the backend running on port 8000?`);
    } finally {
      setBusy(false);
    }
  }

  // re-transcribe when melody toggle changes
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (lastFileRef.current && !busy) transcribe(lastFileRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [melody]);

  // ---- mic recording (raw PCM → WAV) ----
  async function toggleRecord() {
    if (recording) {
      recStopRef.current?.();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(proc);
      proc.connect(ctx.destination);
      recStopRef.current = () => {
        proc.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const wav = encodeWav(chunks, ctx.sampleRate);
        ctx.close();
        transcribe(new File([wav], "recording.wav", { type: "audio/wav" }));
      };
      setRecording(true);
      setStatus("Recording… play your song near the mic, then press Stop.");
    } catch {
      setStatus("Microphone access denied.");
    }
  }

  function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
    const len = chunks.reduce((s, c) => s + c.length, 0);
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const ws = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); ws(36, "data"); v.setUint32(40, len * 2, true);
    let off = 44;
    for (const c of chunks) for (let i = 0; i < c.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, c[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  // ---- practice mode (mic pitch detection) ----
  async function startPractice() {
    if (!notes.length) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const ctx = (audioCtxRef.current ??= new AudioContext());
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      analyserRef.current = analyser;
      pitchBufRef.current = new Float32Array(analyser.fftSize);
      micStopRef.current = () => {
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        analyserRef.current = null;
      };
      hitsRef.current.clear();
      setLiveHits(0);
      timeRef.current = 0;
      playedRef.current.clear();
      practicingRef.current = true;
      setPracticing(true);
      playingRef.current = true;
      setPlaying(true);
      setStatus("Practice: play along on your instrument. Hit notes turn green.");
    } catch {
      setStatus("Practice needs microphone access.");
    }
  }

  const stopPractice = useCallback((save: boolean) => {
    if (!practicingRef.current) return;
    practicingRef.current = false;
    setPracticing(false);
    playingRef.current = false;
    setPlaying(false);
    micStopRef.current?.();
    micStopRef.current = null;
    const total = notesRef.current.length;
    const hits = hitsRef.current.size;
    const accuracy = total ? hits / total : 0;
    if (save && total) {
      setStatus(`Practice done: ${hits}/${total} notes (${Math.round(accuracy * 100)}%).`);
      const songId = currentSongIdRef.current;
      if (songId != null) {
        fetch(`${API}/songs/${songId}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accuracy, notes_hit: hits, notes_total: total, speed: speedRef.current }),
        }).then(() => { loadSessions(songId); loadSongs(); });
      }
    }
  }, [loadSongs]);

  /** Autocorrelation pitch detector → MIDI pitch or null. */
  function detectPitch(): number | null {
    const analyser = analyserRef.current;
    const buf = pitchBufRef.current;
    const ctx = audioCtxRef.current;
    if (!analyser || !buf || !ctx) return null;
    analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
    const n = buf.length;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.01) return null; // silence

    const sr = ctx.sampleRate;
    const minLag = Math.floor(sr / 2100); // ~C7
    const maxLag = Math.floor(sr / 55);   // ~A1
    let bestLag = -1, best = 0;
    for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
      let sum = 0;
      for (let i = 0; i < n - lag; i++) sum += buf[i] * buf[i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    if (bestLag < 0) return null;
    let norm = 0;
    for (let i = 0; i < n - bestLag; i++) norm += buf[i] * buf[i];
    if (norm === 0 || best / norm < 0.5) return null; // weak periodicity
    const freq = sr / bestLag;
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    return midi >= 21 && midi <= 108 ? midi : null;
  }

  // ---- render loop ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let last = performance.now();

    const LOW = 36, HIGH = 96; // C2..C7
    const LOOKAHEAD = 4; // seconds visible above keyboard

    function draw(now: number) {
      const dt = (now - last) / 1000;
      last = now;
      const W = canvas!.width, H = canvas!.height;
      const KB = 90;
      const laneH = H - KB;
      const nKeys = HIGH - LOW + 1;
      const keyW = W / nKeys;

      if (playingRef.current) {
        timeRef.current += dt * speedRef.current;
        const { a, b } = loopRef.current;
        if (a !== null && b !== null && timeRef.current > b) {
          timeRef.current = a;
          playedRef.current.clear();
        }
        const dur = notesRef.current.length ? Math.max(...notesRef.current.map((n) => n.end)) : 0;
        if (timeRef.current > dur + 1) {
          if (practicingRef.current) {
            stopPractice(true);
          } else {
            playingRef.current = false;
            setPlaying(false);
          }
        }
      }
      const t = timeRef.current;

      // practice: sample mic pitch and mark hits
      let detected: number | null = null;
      if (practicingRef.current) {
        detected = detectPitch();
        if (detected !== null) {
          const win = 0.25 / speedRef.current;
          for (const n of notesRef.current) {
            const id = idOf(n);
            if (hitsRef.current.has(id)) continue;
            if (t >= n.start - win && t <= n.end + win && n.pitch === detected) {
              hitsRef.current.add(id);
            }
          }
          setLiveHits(hitsRef.current.size);
        }
      }

      ctx.fillStyle = "#0f1117";
      ctx.fillRect(0, 0, W, H);

      // falling notes
      const active = new Set<number>();
      for (const n of notesRef.current) {
        if (n.pitch < LOW || n.pitch > HIGH) continue;
        const yStart = laneH - ((n.start - t) / LOOKAHEAD) * laneH;
        const yEnd = laneH - ((n.end - t) / LOOKAHEAD) * laneH;
        if (yEnd > laneH && yStart < 0) continue;
        const x = (n.pitch - LOW) * keyW;
        const h = Math.max(yStart - yEnd, 8);
        const isActive = t >= n.start && t <= n.end;
        const isHit = practicingRef.current && hitsRef.current.has(idOf(n));
        if (isActive) {
          active.add(n.pitch);
          if (playingRef.current && !practicingRef.current && !playedRef.current.has(idOf(n))) {
            playedRef.current.add(idOf(n));
            playTone(n.pitch, (n.end - n.start) / speedRef.current);
          }
        }
        if (yEnd < laneH && yStart > 0) {
          ctx.fillStyle = isHit ? "#4caf50"
            : isActive ? "#7ee0a3"
            : isBlack(n.pitch) ? "#4b7bd6" : "#6fa8ff";
          roundRect(ctx, x + 1, Math.max(yEnd, 0), keyW - 2, Math.min(h, laneH), 4);
          if (keyW > 14 && h > 16) {
            ctx.fillStyle = "#0f1117";
            ctx.font = `${Math.min(11, keyW - 4)}px system-ui`;
            ctx.textAlign = "center";
            ctx.fillText(NOTE_NAMES[n.pitch % 12], x + keyW / 2, Math.min(Math.max(yEnd, 0) + 13, laneH - 4));
          }
        }
      }

      // hit line
      ctx.fillStyle = "#e8c15a";
      ctx.fillRect(0, laneH - 2, W, 2);

      // keyboard
      for (let p = LOW; p <= HIGH; p++) {
        const x = (p - LOW) * keyW;
        const black = isBlack(p);
        const isDetected = detected === p;
        ctx.fillStyle = isDetected ? "#e8c15a" : active.has(p) ? "#7ee0a3" : black ? "#1c1f2a" : "#f2f2f2";
        ctx.fillRect(x + 0.5, laneH, keyW - 1, black ? KB * 0.62 : KB);
        ctx.strokeStyle = "#0f1117";
        ctx.strokeRect(x + 0.5, laneH, keyW - 1, KB);
        if (p % 12 === 0) {
          ctx.fillStyle = "#888";
          ctx.font = "10px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(noteName(p), x + keyW / 2, laneH + KB - 6);
        }
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [stopPractice]);

  function idOf(n: Note) {
    return n.pitch * 100000 + Math.round(n.start * 1000);
  }

  function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.fill();
  }

  function togglePlay() {
    audioCtxRef.current?.resume();
    playingRef.current = !playingRef.current;
    setPlaying(playingRef.current);
  }

  function restart() {
    timeRef.current = loop.a ?? 0;
    playedRef.current.clear();
  }

  function setLoopPoint() {
    if (loop.a === null) setLoop({ a: timeRef.current, b: null });
    else if (loop.b === null && timeRef.current > loop.a) setLoop({ a: loop.a, b: timeRef.current });
    else setLoop({ a: null, b: null });
  }

  const btn: React.CSSProperties = {
    background: "#232736", color: "#e6e6e6", border: "1px solid #3a3f52",
    borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 14,
  };
  const panel: React.CSSProperties = {
    border: "1px solid #262b3b", borderRadius: 12, padding: 12, background: "#151823",
  };

  const currentSong = songs.find((s) => s.id === currentSongId);

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>🎹 Crystallizer</h1>
      <p style={{ margin: "0 0 12px", color: "#9aa0b4", fontSize: 14 }}>{status}</p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
        <label style={{ ...btn, display: "inline-block" }}>
          {busy ? "Working…" : "Upload audio"}
          <input type="file" accept="audio/*" hidden disabled={busy}
            onChange={(e) => e.target.files?.[0] && transcribe(e.target.files[0])} />
        </label>
        <button style={{ ...btn, background: recording ? "#8a2f3b" : btn.background }} onClick={toggleRecord} disabled={busy}>
          {recording ? "■ Stop recording" : "🎤 Record"}
        </button>
        <button style={btn} onClick={togglePlay} disabled={!notes.length || practicing}>
          {playing && !practicing ? "Pause" : "Play"}
        </button>
        <button style={btn} onClick={restart} disabled={!notes.length}>⟲ Restart</button>
        <button style={btn} onClick={setLoopPoint} disabled={!notes.length}>
          {loop.a === null ? "Loop: set start" : loop.b === null ? "Loop: set end" : "Loop: clear"}
        </button>
        <button
          style={{ ...btn, background: practicing ? "#8a2f3b" : "#2f5e3d" }}
          onClick={() => (practicing ? stopPractice(true) : startPractice())}
          disabled={!notes.length}
        >
          {practicing ? "■ End practice" : "▶ Practice"}
        </button>
        <button style={btn} onClick={() => saveToLibrary()} disabled={!notes.length || currentSongId !== null}>
          {currentSongId !== null ? "✓ In library" : "💾 Save to library"}
        </button>
        <button style={btn} onClick={() => setShowSheet((s) => !s)} disabled={!notes.length}>
          {showSheet ? "Hide sheet music" : "🎼 Sheet music"}
        </button>
        <label style={{ fontSize: 14, color: "#9aa0b4" }}>
          Speed {Math.round(speed * 100)}%
          <input type="range" min={0.25} max={1} step={0.05} value={speed}
            onChange={(e) => setSpeed(+e.target.value)} style={{ verticalAlign: "middle", marginLeft: 6 }} />
        </label>
        <label style={{ fontSize: 14, color: "#9aa0b4" }}>
          <input type="checkbox" checked={melody} onChange={(e) => setMelody(e.target.checked)} /> Melody only
        </label>
      </div>

      {practicing && (
        <p style={{ color: "#7ee0a3", fontSize: 14, margin: "0 0 8px" }}>
          Practicing{currentSong ? ` "${currentSong.name}"` : ""} — {liveHits}/{notes.length} notes hit
        </p>
      )}

      <canvas ref={canvasRef} width={1080} height={560}
        style={{ width: "100%", borderRadius: 12, border: "1px solid #262b3b", display: "block" }} />
      <p style={{ color: "#6b7189", fontSize: 12, marginTop: 8 }}>
        Tip: start with Melody only at 50% speed. Practice mode listens to your instrument through the mic and scores each note.
        {duration > 0 && ` · Song length: ${duration.toFixed(1)}s`}
      </p>

      {showSheet && notes.length > 0 && (
        <div style={{ ...panel, marginTop: 12, background: "#fff" }}>
          <SheetMusic notes={notes} />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
        <div style={panel}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>📚 Library</h2>
          {songs.length === 0 && (
            <p style={{ color: "#6b7189", fontSize: 13 }}>No saved songs yet. Upload or record audio, then save it here.</p>
          )}
          {songs.map((s) => (
            <div key={s.id} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "6px 4px",
              borderBottom: "1px solid #232736",
              background: s.id === currentSongId ? "#1d2333" : "transparent", borderRadius: 6,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                <div style={{ fontSize: 12, color: "#6b7189" }}>
                  {s.duration.toFixed(0)}s · {s.sessions} session{s.sessions === 1 ? "" : "s"} · best {pct(s.best_accuracy)} · last {pct(s.last_accuracy)}
                </div>
              </div>
              <button style={{ ...btn, padding: "4px 10px", fontSize: 13 }} onClick={() => loadSong(s.id)}>Open</button>
              <button style={{ ...btn, padding: "4px 10px", fontSize: 13, color: "#d98a94" }} onClick={() => deleteSong(s.id)}>✕</button>
            </div>
          ))}
        </div>

        <div style={panel}>
          <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>
            📈 Practice history{currentSong ? ` — ${currentSong.name}` : ""}
          </h2>
          {currentSongId === null && (
            <p style={{ color: "#6b7189", fontSize: 13 }}>Open a song from the library to see its practice stats.</p>
          )}
          {currentSongId !== null && sessions.length === 0 && (
            <p style={{ color: "#6b7189", fontSize: 13 }}>No practice sessions yet — press Practice and play along.</p>
          )}
          {sessions.map((s) => (
            <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "5px 4px", borderBottom: "1px solid #232736", fontSize: 13 }}>
              <span style={{
                minWidth: 48, textAlign: "center", borderRadius: 6, padding: "2px 6px",
                background: s.accuracy >= 0.8 ? "#2f5e3d" : s.accuracy >= 0.5 ? "#5e532f" : "#5e2f38",
              }}>{Math.round(s.accuracy * 100)}%</span>
              <span style={{ color: "#9aa0b4" }}>{s.notes_hit}/{s.notes_total} notes</span>
              <span style={{ color: "#6b7189" }}>at {Math.round(s.speed * 100)}% speed</span>
              <span style={{ color: "#6b7189", marginLeft: "auto" }}>{s.created_at.replace("T", " ").slice(0, 16)} UTC</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
