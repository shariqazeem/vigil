"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WardenEmit } from "@/agent/incident-context";
import { isHalted, statusChip } from "@/lib/incident-status";

/**
 * THE TIMELINE. What Warden did, in the order it did it.
 *
 * Every row is one real thing: a command that ran, a policy sentence, a diagnosis it committed to,
 * a verdict from re-running the probe. Nothing here is a status message and nothing is on a timer —
 * if the screen is still, Warden is thinking, and the elapsed clock on the last row says so.
 */

export interface OpenQuestion {
  id: string;
  question: string;
  proposal: string | null;
  because: string | null;
  options: { value: string; label: string; tone?: string }[];
}

type Phase = "idle" | "working" | "halted" | "done";

export function Live({
  incidentId,
  open,
  canRun,
  resolved,
}: {
  incidentId: string;
  open: OpenQuestion | null;
  canRun: boolean;
  resolved: boolean;
}) {
  const [events, setEvents] = useState<WardenEmit[]>([]);
  const [phase, setPhase] = useState<Phase>(open ? "halted" : resolved ? "done" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const es = useRef<EventSource | null>(null);
  const router = useRouter();

  const close = useCallback(() => {
    es.current?.close();
    es.current = null;
  }, []);
  useEffect(() => () => close(), [close]);

  const connect = useCallback(
    (query: string) => {
      close();
      setEvents([]);
      setError(null);
      setPhase("working");
      const source = new EventSource(`/api/incidents/${incidentId}/run${query}`);
      es.current = source;
      source.onmessage = (m) => {
        const e = JSON.parse(m.data) as WardenEmit;
        setEvents((xs) => [...xs, e]);
        if (e.kind === "decision") setPhase("halted");
        if (e.kind === "error") setError(e.message);
        if (e.kind === "run.done") {
          setPhase(isHalted(e.status) ? "halted" : "done");
          router.refresh();
        }
      };
      source.onerror = () => {
        close();
        setPhase((p) => (p === "working" ? "done" : p));
        router.refresh();
      };
    },
    [close, incidentId, router],
  );

  const answer = (value: string) => {
    if (!open) return;
    const q = new URLSearchParams({ mode: "resume", decision: open.id, answer: value });
    if (note.trim()) q.set("note", note.trim().slice(0, 300));
    connect(`?${q.toString()}`);
  };

  return (
    <section className="lv">
      <header className="lv-bar">
        <span className={`chip ${phase === "working" ? "is-accent is-live" : phase === "halted" ? "is-warn" : phase === "done" ? "is-ok" : "is-unknown"}`}>
          {phase === "working" ? "Warden is working" : phase === "halted" ? "Waiting on you" : phase === "done" ? "Finished" : "Not started"}
        </span>
        {canRun ? (
          <button type="button" className="btn btn-sm" onClick={() => connect("")} disabled={phase === "working" || phase === "halted"}>
            {phase === "working" ? "Working…" : events.length ? "Run again" : "Hand it to Warden"}
          </button>
        ) : null}
      </header>

      {events.length === 0 && phase === "idle" ? (
        <p className="lv-empty">
          Nothing has been done about this yet. Hand it to Warden and watch — every command it runs, every policy decision, and the
          check it re-runs at the end will appear here as it happens.
        </p>
      ) : null}

      <ol className="lv-rows">
        {events.map((e, i) => (
          <Row key={i} e={e} last={i === events.length - 1 && phase === "working"} />
        ))}
      </ol>

      {error ? <p className="lv-err">{error}</p> : null}

      {open && phase === "halted" ? (
        <div className="ask card">
          <p className="micro ask-k">Warden stopped and is asking</p>
          <h3 className="ask-q">{open.question}</h3>
          {open.proposal ? (
            <div className="ask-proposal">
              <p className="micro">exactly what it would do</p>
              <pre className="well ask-pre">{open.proposal}</pre>
            </div>
          ) : null}
          {open.because ? (
            <p className="ask-because">
              <span className="micro">why it is asking</span>
              {open.because}
            </p>
          ) : null}
          <input className="ask-note" value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Anything to add — it becomes a standing rule" maxLength={300} />
          <div className="ask-opts">
            {open.options.map((o) => (
              <button key={o.value} type="button" className={`btn ${o.tone === "primary" ? "btn-accent" : "btn-quiet"}`} onClick={() => answer(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ── one row ──────────────────────────────────────────────────────── */

function Row({ e, last }: { e: WardenEmit; last: boolean }) {
  const body = render(e);
  if (!body) return null;
  return (
    <li className={`lv-row is-${body.tone} ${last ? "is-last" : ""}`}>
      <span className="lv-dot" aria-hidden="true" />
      <div className="lv-body">
        <p className="lv-head">
          <span className="lv-kind micro">{body.kind}</span>
          <span className="lv-title">{body.title}</span>
          {body.meta ? <span className="lv-meta mono">{body.meta}</span> : null}
        </p>
        {body.detail ? <p className="lv-detail">{body.detail}</p> : null}
        {body.out ? <pre className="well lv-out">{body.out}</pre> : null}
      </div>
    </li>
  );
}

type Tone = "quiet" | "look" | "think" | "policy" | "act" | "ok" | "bad" | "ask";

function render(e: WardenEmit): { kind: string; title: string; meta?: string; detail?: string; out?: string; tone: Tone } | null {
  switch (e.kind) {
    case "run.start":
      return { kind: "start", title: e.title, meta: e.model, tone: "quiet" };
    case "node.start":
      return { kind: "step", title: e.label, tone: "quiet" };
    case "look":
      return { kind: "looks at", title: e.command, detail: e.why, tone: "look" };
    case "looked":
      return { kind: e.ok ? "reads" : "nothing there", title: firstLine(e.summary), meta: `${e.ms}ms`, out: e.summary.length > 90 ? e.summary : undefined, tone: e.ok ? "look" : "quiet" };
    case "diagnosis":
      return { kind: `diagnosis · ${Math.round(e.confidence * 100)}% sure`, title: e.suspect ?? "cause identified", detail: e.text, tone: "think" };
    case "policy":
      return {
        kind: `policy · ${e.verdict}`,
        title: e.rule,
        detail: e.reason,
        tone: e.verdict === "allow" ? "policy" : e.verdict === "ask" ? "ask" : "bad",
      };
    case "act":
      return { kind: "acts", title: e.command, detail: e.why, tone: "act" };
    case "acted":
      return { kind: e.ok ? "done" : "failed", title: firstLine(e.summary), meta: `${e.ms}ms`, out: e.summary.length > 90 ? e.summary : undefined, tone: e.ok ? "act" : "bad" };
    case "probe.start":
      return { kind: "re-runs the check", title: e.command || e.label, tone: "quiet" };
    case "probe.done":
      return { kind: e.ok ? "passes" : "still failing", title: e.detail, meta: `${e.ms}ms`, tone: e.ok ? "ok" : "bad" };
    case "verify":
      return { kind: "verdict", title: e.ok ? `${e.label} passes again` : `${e.label} still fails`, detail: e.detail, tone: e.ok ? "ok" : "bad" };
    case "decision":
      return { kind: "stops", title: e.question, detail: e.because ?? undefined, tone: "ask" };
    case "run.done":
      return { kind: statusChip(e.status).label, title: e.summary, meta: e.downSeconds !== null ? `down ${fmt(e.downSeconds)}` : undefined, tone: e.status === "resolved" ? "ok" : "ask" };
    case "error":
      return { kind: "problem", title: e.message, tone: "bad" };
    default:
      return null;
  }
}

const firstLine = (s: string) => (s.split("\n")[0] ?? s).slice(0, 150);
const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
