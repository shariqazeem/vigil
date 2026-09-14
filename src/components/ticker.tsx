"use client";

import { useEffect, useRef, useState } from "react";

interface Line {
  id: string;
  at: number;
  text: string;
}

function hhmmss(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * The strip across the top of the app — real fleet activity in mono, streaming. Polls every 5s
 * (paused when the tab is hidden), version-gated so an unchanged payload is a no-op. The track is
 * doubled for a seamless loop. Under reduced motion it renders only the latest line, statically.
 * Empty (nothing real yet) → renders nothing.
 */
export function Ticker() {
  const [lines, setLines] = useState<Line[]>([]);
  const lastVer = useRef<string>("");

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      if (document.hidden && lastVer.current !== "") return; // the first fetch always runs; later ones wait for a visible tab
      try {
        const res = await fetch("/api/ticker", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { lines?: Line[] };
        const next = j.lines ?? [];
        const ver = next.map((l) => l.id).join(",");
        if (ver === lastVer.current) return;
        lastVer.current = ver;
        setLines(next);
      } catch {
        /* transient — next tick retries */
      }
    };
    void tick();
    timer = setInterval(() => void tick(), 5000);
    const onVis = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  if (lines.length === 0) return null;

  const ordered = [...lines].reverse();
  const latest = lines[0]!;

  return (
    <div className="wd-ticker" role="log" aria-label="Live activity">
      <div className="wd-ticker-track" aria-hidden>
        {[...ordered, ...ordered].map((l, i) => (
          <span className="wd-ticker-item mono" key={`${l.id}-${i}`}>
            <span className="wd-ticker-time">{hhmmss(l.at)}</span>
            {l.text}
          </span>
        ))}
      </div>
      <span className="wd-ticker-latest mono">
        <span className="wd-ticker-time">{hhmmss(latest.at)}</span>
        {latest.text}
      </span>
    </div>
  );
}
