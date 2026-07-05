"use client";

import { useEffect, useRef } from "react";

type Note = { start: number; end: number; pitch: number; amplitude: number };

const LETTERS = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const vexKey = (p: number) => `${LETTERS[p % 12]}/${Math.floor(p / 12) - 1}`;

/** Group notes into chord events by (near-)simultaneous start time. */
function toEvents(notes: Note[], window = 0.06) {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const events: { start: number; pitches: number[] }[] = [];
  for (const n of sorted) {
    const last = events[events.length - 1];
    if (last && n.start - last.start < window) {
      if (!last.pitches.includes(n.pitch)) last.pitches.push(n.pitch);
    } else {
      events.push({ start: n.start, pitches: [n.pitch] });
    }
  }
  return events;
}

/**
 * Renders notes on a grand staff (treble + bass, split at middle C).
 * Rhythm is simplified: each chord event is drawn as a quarter note,
 * 8 events per measure — a readable "pitch view", not engraved notation.
 */
export default function SheetMusic({ notes }: { notes: Note[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = "";
    let cancelled = false;

    (async () => {
      const VF = await import("vexflow");
      if (cancelled) return;
      const { Renderer, Stave, StaveNote, GhostNote, Voice, Formatter, StaveConnector } = VF;

      const events = toEvents(notes);
      const PER_MEASURE = 8;
      const MEASURES_PER_LINE = 2;
      const MEASURE_W = 460;
      const LINE_H = 230;
      const nMeasures = Math.max(1, Math.ceil(events.length / PER_MEASURE));
      const nLines = Math.ceil(nMeasures / MEASURES_PER_LINE);

      const width = 30 + MEASURES_PER_LINE * MEASURE_W + 20;
      const height = nLines * LINE_H + 20;
      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(width, height);
      const ctx = renderer.getContext();

      for (let m = 0; m < nMeasures; m++) {
        const line = Math.floor(m / MEASURES_PER_LINE);
        const col = m % MEASURES_PER_LINE;
        const x = 20 + col * MEASURE_W;
        const yT = 20 + line * LINE_H;
        const yB = yT + 90;

        const treble = new Stave(x, yT, MEASURE_W);
        const bass = new Stave(x, yB, MEASURE_W);
        if (col === 0) {
          treble.addClef("treble");
          bass.addClef("bass");
          new StaveConnector(treble, bass).setType("brace").setContext(ctx);
        }
        treble.setContext(ctx).draw();
        bass.setContext(ctx).draw();
        if (col === 0) new StaveConnector(treble, bass).setType("brace").setContext(ctx).draw();
        new StaveConnector(treble, bass).setType("singleLeft").setContext(ctx).draw();

        const slice = events.slice(m * PER_MEASURE, (m + 1) * PER_MEASURE);
        const tNotes: InstanceType<typeof StaveNote | typeof GhostNote>[] = [];
        const bNotes: InstanceType<typeof StaveNote | typeof GhostNote>[] = [];
        for (const ev of slice) {
          const hi = ev.pitches.filter((p) => p >= 60).sort((a, b) => a - b);
          const lo = ev.pitches.filter((p) => p < 60).sort((a, b) => a - b);
          tNotes.push(
            hi.length
              ? new StaveNote({ clef: "treble", keys: hi.map(vexKey), duration: "q" })
              : new GhostNote({ duration: "q" })
          );
          bNotes.push(
            lo.length
              ? new StaveNote({ clef: "bass", keys: lo.map(vexKey), duration: "q" })
              : new GhostNote({ duration: "q" })
          );
        }
        // pad last measure so voices agree
        while (tNotes.length < PER_MEASURE && m === nMeasures - 1 && slice.length) {
          tNotes.push(new GhostNote({ duration: "q" }));
          bNotes.push(new GhostNote({ duration: "q" }));
        }
        if (!tNotes.length) continue;

        const vT = new Voice({ numBeats: tNotes.length, beatValue: 4 }).setStrict(false).addTickables(tNotes);
        const vB = new Voice({ numBeats: bNotes.length, beatValue: 4 }).setStrict(false).addTickables(bNotes);
        new Formatter()
          .joinVoices([vT])
          .joinVoices([vB])
          .format([vT, vB], MEASURE_W - (col === 0 ? 80 : 30));
        vT.draw(ctx, treble);
        vB.draw(ctx, bass);
      }
    })();

    return () => { cancelled = true; };
  }, [notes]);

  return (
    <div style={{ overflowX: "auto" }}>
      <p style={{ color: "#555", fontSize: 12, margin: "0 0 6px" }}>
        Simplified notation: pitches in order, rhythm not to scale. Treble/bass split at middle C.
      </p>
      <div ref={ref} />
    </div>
  );
}
