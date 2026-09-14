"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Field, type FieldThing, type LiveEvent } from "@/components/field/field";

/**
 * The live watch. It owns exactly one thing: the connection to a running pass, and the events that
 * come back from it. Everything on screen is a fold of those events, so a reload replays the same
 * picture and there is no second source of truth to drift from.
 *
 * A replay is never dressed as a live run. If these events came off a recording the banner says so,
 * with the date the pass actually ran.
 */

export interface OpenQuestion {
  id: string;
  question: string;
  context: string | null;
  options: { value: string; label: string; tone?: string }[];
  thingLabel: string | null;
}

type Phase = "idle" | "running" | "halted" | "done";

export function Watch({
  householdId,
  things,
  open,
  hasRecording,
  lastPassAt,
  canRun,
}: {
  householdId: string;
  things: FieldThing[];
  open: OpenQuestion | null;
  hasRecording: boolean;
  lastPassAt: number | null;
  canRun: boolean;
}) {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [phase, setPhase] = useState<Phase>(open ? "halted" : "idle");
  const [replay, setReplay] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState<string | null>(null);
  const es = useRef<EventSource | null>(null);
  const router = useRouter();

  const close = useCallback(() => {
    es.current?.close();
    es.current = null;
  }, []);

  useEffect(() => () => close(), [close]);

  const connect = useCallback(
    (query: string, isReplay: boolean) => {
      close();
      setEvents([]);
      setError(null);
      setSummary(null);
      setReplay(isReplay);
      setPhase("running");
      const source = new EventSource(`/api/households/${householdId}/watch?${query}`);
      es.current = source;
      source.onmessage = (m) => {
        const e = JSON.parse(m.data) as LiveEvent;
        setEvents((xs) => [...xs, e]);
        if (e.kind === "decision") setPhase("halted");
        if (e.kind === "error") setError(e.message);
        if (e.kind === "pass.done") {
          setPhase(e.status === "interrupted" ? "halted" : "done");
          if (!isReplay) router.refresh();
        }
      };
      source.onerror = () => {
        close();
        setPhase((p) => (p === "running" ? "done" : p));
        if (!isReplay) router.refresh();
      };
    },
    [close, householdId, router],
  );

  const answer = (value: string) => {
    if (!open) return;
    const q = new URLSearchParams({ mode: "resume", decision: open.id, answer: value });
    if (note.trim()) q.set("note", note.trim().slice(0, 300));
    setSummary(null);
    connect(q.toString(), false);
  };

  const askingQuestion = phase === "halted" ? (open?.question ?? lastQuestion(events)) : null;

  return (
    <section className="wt">
      <div className="wt-bar">
        <div className="wt-state">
          <span className={`wt-dot is-${phase}`} aria-hidden="true" />
          <p className="wt-state-t">
            {phase === "running"
              ? replay
                ? "Playing back a watch that already happened"
                : "Vigil is looking"
              : phase === "halted"
                ? "Stopped — it needs one answer from you"
                : lastPassAt
                  ? `Last watched ${when(lastPassAt)}`
                  : "Never watched yet"}
          </p>
        </div>
        <div className="wt-actions">
          {hasRecording ? (
            <button type="button" className="btn btn-quiet" onClick={() => connect("mode=replay", true)} disabled={phase === "running"}>
              Replay the last watch
            </button>
          ) : null}
          {canRun ? (
            <button type="button" className="btn" onClick={() => connect("mode=run", false)} disabled={phase === "running" || phase === "halted"}>
              {phase === "running" ? "Looking…" : "Watch now"}
            </button>
          ) : null}
        </div>
      </div>

      {replay && phase !== "idle" ? (
        <p className="wt-replay mono">
          replay · this is a recording of a real pass, played at its own pace. Nothing here is happening right now.
        </p>
      ) : null}

      <Field things={things} events={events} phase={phase} askingQuestion={askingQuestion} />

      {error ? <p className="wt-err">{error}</p> : null}

      {open && phase === "halted" ? (
        <div className="ask">
          <p className="ask-eyebrow mono">
            vigil stopped · {open.thingLabel ?? "one of your things"}
          </p>
          <h3 className="ask-q serif">{open.question}</h3>
          {open.context ? <p className="ask-ctx">{open.context}</p> : null}
          <label className="ask-note">
            <span className="sr-only">Anything you want to add</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add what you saw, if you like — it becomes a rule" maxLength={300} />
          </label>
          <div className="ask-opts">
            {open.options.map((o) => (
              <button key={o.value} type="button" className={`btn ${o.tone === "danger" ? "btn-alarm" : o.tone === "primary" ? "" : "btn-quiet"}`} onClick={() => answer(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
          <p className="ask-foot">
            Whatever you answer is kept in your words, so Vigil never asks it twice.
          </p>
        </div>
      ) : null}

      {summary ? <p className="wt-summary">{summary}</p> : null}
    </section>
  );
}

function lastQuestion(events: LiveEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.kind === "decision") return e.question;
  }
  return null;
}

function when(at: number): string {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 2) return "just now";
  if (mins < 90) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}
