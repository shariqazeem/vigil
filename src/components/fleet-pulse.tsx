"use client";

import { useEffect, useRef, useState } from "react";

export interface PulseService {
  id: string;
  name: string;
  open: number;
  stance: { label: string; tone: string };
  last: string;
  lastAt: number | null;
  spark: { id: string; ok: boolean }[];
}

export interface PulseLine {
  id: string;
  at: number;
  text: string;
  tone?: string;
}

/**
 * THE LIVE PANEL beside the words on the landing page — the product, not a drawing of it.
 *
 * Server-rendered full, then kept alive: the ticker lines come from /api/ticker every 5s (version-
 * gated by ids, paused while the tab is hidden), and the heartbeat line says how long ago the fleet
 * was last checked. `now` is null until mount so the server and the client agree on first paint.
 * Empty → one honest waiting line, never an invented row.
 */
export function FleetPulse({ services, initial }: { services: PulseService[]; initial: PulseLine[] }) {
  const [lines, setLines] = useState<PulseLine[]>(initial);
  const [now, setNow] = useState<number | null>(null);
  const lastVer = useRef(initial.map((l) => l.id).join(","));

  useEffect(() => {
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 10_000);
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/ticker", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { lines?: PulseLine[] };
        const next = j.lines ?? [];
        const ver = next.map((l) => l.id).join(",");
        if (ver === lastVer.current) return;
        lastVer.current = ver;
        setLines(next);
      } catch {
        /* next tick retries */
      }
    };
    const timer = setInterval(() => void tick(), 5000);
    const onVis = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(clock);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const lastCheck = Math.max(0, ...services.map((s) => s.lastAt ?? 0), ...lines.map((l) => l.at));
  const beat = now && lastCheck ? heartbeat(now - lastCheck) : null;

  return (
    <div className="hl lx-rise lx-rise-3" aria-label="The live fleet">
      <div className="hl-h">
        <span className="hl-title">The fleet, right now</span>
        <span className="hl-live mono">
          <span className="hl-dot" aria-hidden /> live
        </span>
      </div>

      <div className="hl-svcs">
        {services.map((s) => (
          <div key={s.id} className="lx-svc">
            <div className="lx-svc-h">
              <span className={`chip ${s.open ? "is-down" : "is-ok"}`}>{s.open ? `${s.open} open` : "up"}</span>
              <span className="lx-svc-n">{s.name}</span>
              <span className={`chip is-${s.stance.tone} lx-svc-p`}>{s.stance.label}</span>
            </div>
            <div className="lx-svc-h">
              <span className="lx-spark" aria-hidden>
                {s.spark.map((r) => <i key={r.id} className={r.ok ? "" : "bad"} />)}
              </span>
              <span className="lx-svc-d">{s.last}</span>
            </div>
          </div>
        ))}
      </div>

      {lines.length === 0 ? (
        <div className="hl-empty mono">Waiting for the next check — what happens lands here as it happens.</div>
      ) : (
        <ul className="hl-rows">
          {lines.slice(0, 6).map((l) => (
            <li key={l.id} className={`hl-row is-${l.tone ?? "quiet"}`}>
              <span className="hl-ic" aria-hidden />
              <span className="hl-line">{l.text}</span>
              <span className="hl-ago mono">{now ? since(l.at, now) : ""}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="hl-f mono">
        <span className={beat?.stale ? "is-stale" : ""}>{beat ? beat.text : "last checked …"}</span>
        <span>{services.length} service{services.length === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

function since(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function heartbeat(ms: number): { text: string; stale: boolean } {
  const s = Math.max(0, Math.round(ms / 1000));
  const ago = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  return s > 600 ? { text: `last checked ${ago} · may be delayed`, stale: true } : { text: `last checked ${ago}`, stale: false };
}
