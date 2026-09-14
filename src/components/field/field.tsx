"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Glyph, glyphNameFor } from "./glyphs";
import type { PassEmit } from "@/agent/pass-context";

/**
 * THE FIELD — the household at night, and the agent moving through it.
 *
 * One rule governs every pixel: nothing here is on a timer. The lamp travels to a thing because a
 * real HTTP request to a real federal API has just started, and it stays there while that request
 * is genuinely in flight. A node prints a row count because that many rows came back. A node turns
 * red because a government record was matched to it. The field freezes because the agent has
 * actually stopped — `stopReason: interrupt` — and it will not move again until someone answers.
 *
 * So there is no fake progress anywhere in this file, and there is no state that a reload could
 * disagree with: every frame is a function of events the server emitted, replayed in order.
 */

export type LiveEvent = PassEmit & { replay?: true };

export interface FieldThing {
  id: string;
  kind: string;
  label: string;
  make: string | null;
  model: string | null;
  year: number | null;
  category: string | null;
  secondHand: boolean;
  lastCheckedAt: number | null;
  findings: { sourceId: string; severity: string }[];
}

type NodeState = "quiet" | "looking" | "clear" | "alarm" | "asking";

interface Live {
  checking: Record<string, { source: string; endpoint: string }>;
  rows: Record<string, number>;
  sources: Record<string, number>;
  failed: Record<string, string>;
  found: Record<string, { sourceId: string; severity: string }[]>;
  asking: string | null;
}

const EMPTY: Live = { checking: {}, rows: {}, sources: {}, failed: {}, found: {}, asking: null };

/** Deterministic: the same household always draws the same constellation. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function layout(ids: string[]): Record<string, { x: number; y: number }> {
  const n = ids.length;
  const out: Record<string, { x: number; y: number }> = {};
  const start = n ? hash(ids[0]!) * Math.PI * 2 : 0;
  ids.forEach((id, i) => {
    const ring = n <= 5 ? 0 : Math.floor(i / 5);
    const inRing = n <= 5 ? n : Math.min(5, n - ring * 5);
    const idx = n <= 5 ? i : i % 5;
    const a = start + (idx / inRing) * Math.PI * 2 + ring * 0.6;
    const rx = (n === 1 ? 0 : 30 - ring * 9) + hash(id) * 5;
    const ry = (n === 1 ? 0 : 25 - ring * 8) + hash(`${id}y`) * 5;
    out[id] = { x: 50 + Math.cos(a) * rx, y: 50 + Math.sin(a) * ry };
  });
  return out;
}

export function Field({
  things,
  events,
  phase,
  askingQuestion,
}: {
  things: FieldThing[];
  events: LiveEvent[];
  phase: "idle" | "running" | "halted" | "done";
  askingQuestion?: string | null;
}) {
  const pos = useMemo(() => layout(things.map((t) => t.id)), [things]);
  const [ticker, setTicker] = useState<{ line: string; ok: boolean | null }[]>([]);
  const seen = useRef(new Set<number>());

  // Fold the event stream into what the field shows. Replaying the same events always produces the
  // same picture — the board after a reload is the board you were watching.
  const live = useMemo(() => {
    const s: Live = { ...EMPTY, checking: {}, rows: {}, sources: {}, failed: {}, found: {} };
    for (const e of events) {
      if (e.kind === "check.start") s.checking[e.thingId] = { source: e.source, endpoint: e.endpoint };
      if (e.kind === "check.done") {
        delete s.checking[e.thingId];
        s.rows[e.thingId] = (s.rows[e.thingId] ?? 0) + e.rows;
        s.sources[e.thingId] = (s.sources[e.thingId] ?? 0) + 1;
        if (!e.ok) s.failed[e.thingId] = e.error ?? "no answer";
      }
      if (e.kind === "finding") s.found[e.thingId] = [...(s.found[e.thingId] ?? []), { sourceId: e.sourceId, severity: e.severity }];
      if (e.kind === "decision") s.asking = e.decisionId;
    }
    return s;
  }, [events]);

  // The ticker is the endpoint log: what was asked, what answered, how fast.
  useEffect(() => {
    const next: { line: string; ok: boolean | null }[] = [];
    events.forEach((e, i) => {
      if (seen.current.has(i)) return;
      seen.current.add(i);
      if (e.kind === "check.start") next.push({ line: `GET ${e.endpoint}`, ok: null });
      if (e.kind === "check.done") next.push({ line: `${e.ok ? "200" : "ERR"} ${e.source} → ${e.rows} rows · ${e.ms}ms`, ok: e.ok });
      if (e.kind === "plan") next.push({ line: `plan ${e.sources.join(", ") || "nothing can know"} — ${e.why}`, ok: null });
      if (e.kind === "match") next.push({ line: `${e.sourceId} ${e.verdict} ${Math.round(e.confidence * 100)}%`, ok: e.verdict === "clear" ? true : null });
    });
    if (next.length) setTicker((t) => [...t, ...next].slice(-40));
  }, [events]);

  const active = Object.keys(live.checking)[0] ?? null;
  const lantern = active ? pos[active] : null;
  const frozen = phase === "halted";

  const stateOf = (t: FieldThing): NodeState => {
    if (live.checking[t.id]) return "looking";
    if ((live.found[t.id]?.length ?? 0) > 0 || t.findings.length > 0) return "alarm";
    if (frozen && live.asking) return "asking";
    if ((live.sources[t.id] ?? 0) > 0) return "clear";
    return t.lastCheckedAt ? "clear" : "quiet";
  };

  return (
    <div className={`fld ${frozen ? "is-frozen" : ""} ${phase === "running" ? "is-running" : ""}`} data-phase={phase}>
      <div className="fld-sky" aria-hidden="true" />

      {/* the household: hairlines from each thing to the middle of the home */}
      <svg className="fld-web" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {things.map((t) => {
          const p = pos[t.id];
          return p ? <line key={t.id} x1={p.x} y1={p.y} x2={50} y2={50} /> : null;
        })}
      </svg>

      {/* the lamp. It is where it is because a request to that source is open right now. */}
      <div
        className="fld-lamp"
        style={lantern ? { left: `${lantern.x}%`, top: `${lantern.y}%`, opacity: 1 } : { opacity: 0 }}
        aria-hidden="true"
      />

      <ul className="fld-nodes">
        {things.map((t) => {
          const p = pos[t.id] ?? { x: 50, y: 50 };
          const st = stateOf(t);
          const checking = live.checking[t.id];
          const found = [...(live.found[t.id] ?? []), ...t.findings];
          const worst = found.some((f) => f.severity === "critical") ? "critical" : found[0]?.severity;
          return (
            <li key={t.id} className={`fld-node is-${st}`} style={{ left: `${p.x}%`, top: `${p.y}%` }} data-severity={worst ?? ""}>
              <div className="fld-mark">
                <svg className="fld-ring" viewBox="0 0 100 100" aria-hidden="true">
                  <circle className="fld-ring-track" cx="50" cy="50" r="44" />
                  <circle className="fld-ring-live" cx="50" cy="50" r="44" />
                </svg>
                <span className="fld-glyph">
                  <Glyph name={glyphNameFor(t)} size={44} />
                </span>
                {found.length > 0 ? (
                  <span className="fld-stamp mono" title={found.map((f) => f.sourceId).join(", ")}>
                    {found[0]!.sourceId}
                  </span>
                ) : null}
              </div>
              <p className="fld-label">{t.label}</p>
              <p className="fld-meta mono">
                {[t.year, t.make, t.model].filter(Boolean).join(" ") || t.category || t.kind}
              </p>
              <p className="fld-status mono">
                {checking ? (
                  <span className="is-looking">asking {checking.source}…</span>
                ) : live.failed[t.id] ? (
                  <span className="is-unknown">unchecked — {live.failed[t.id]}</span>
                ) : found.length > 0 ? (
                  <span className="is-alarm">{found.length} record{found.length === 1 ? "" : "s"}</span>
                ) : (live.sources[t.id] ?? 0) > 0 ? (
                  <span className="is-clear">
                    {live.sources[t.id]} source{live.sources[t.id] === 1 ? "" : "s"} · {live.rows[t.id] ?? 0} rows read
                  </span>
                ) : t.lastCheckedAt ? (
                  <span className="is-quiet">last looked {ago(t.lastCheckedAt)}</span>
                ) : (
                  <span className="is-quiet">not looked at yet</span>
                )}
              </p>
            </li>
          );
        })}
      </ul>

      {frozen && askingQuestion ? <div className="fld-scrim" aria-hidden="true" /> : null}

      {frozen && askingQuestion ? (
        <div className="fld-halt" role="status">
          <p className="fld-halt-pill mono">stopReason: interrupt</p>
          <p className="fld-halt-q serif">{askingQuestion}</p>
          <p className="fld-halt-note">The run is stopped here. It stays stopped until you answer.</p>
        </div>
      ) : null}

      <div className="fld-ticker mono" aria-live="off">
        {ticker.slice(-5).map((t, i) => (
          <p key={`${i}-${t.line}`} className={t.ok === false ? "is-err" : t.ok === true ? "is-ok" : ""}>
            {t.line}
          </p>
        ))}
      </div>
    </div>
  );
}

function ago(at: number): string {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
