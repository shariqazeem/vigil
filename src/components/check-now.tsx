"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * CHECK NOW. The same sweep the cron runs, on demand, with the answers appearing as they arrive.
 *
 * The reason this streams rather than showing a spinner is the reason most of this product streams:
 * a watch that says "checking…" and then "all good" is asking to be trusted, and a watch that shows
 * you each probe, its answer and how long it took has already earned it.
 */
type Line = { id: number; ok: boolean | null; label: string; detail: string; ms?: number };

export function CheckNow({ serviceId, label = "Check everything now" }: { serviceId?: string; label?: string }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const es = useRef<EventSource | null>(null);
  const seq = useRef(0);
  const router = useRouter();

  const close = useCallback(() => {
    es.current?.close();
    es.current = null;
  }, []);
  useEffect(() => () => close(), [close]);

  const run = () => {
    close();
    setLines([]);
    setDone(null);
    setBusy(true);
    const source = new EventSource(`/api/sweep${serviceId ? `?service=${encodeURIComponent(serviceId)}` : ""}`);
    es.current = source;
    source.onmessage = (m) => {
      const e = JSON.parse(m.data) as
        | { kind: "probe.done"; label: string; ok: boolean; detail: string; ms: number }
        | { kind: "incident.open"; title: string; symptom: string }
        | { kind: "incident.resolved"; downSeconds: number }
        | { kind: "sweep.note"; message: string }
        | { kind: "sweep.done"; checked: number; opened: number }
        | { kind: "error"; message: string }
        | { kind: string };

      if (e.kind === "probe.done") {
        const d = e as { label: string; ok: boolean; detail: string; ms: number };
        seq.current += 1;
        setLines((xs) => [...xs, { id: seq.current, ok: d.ok, label: d.label, detail: d.detail, ms: d.ms }]);
      } else if (e.kind === "incident.open") {
        const d = e as { title: string; symptom: string };
        seq.current += 1;
        setLines((xs) => [...xs, { id: seq.current, ok: false, label: "incident opened", detail: `${d.title} — ${d.symptom}` }]);
      } else if (e.kind === "incident.resolved") {
        const d = e as { downSeconds: number };
        seq.current += 1;
        setLines((xs) => [...xs, { id: seq.current, ok: true, label: "incident closed", detail: `it came back — down ${d.downSeconds}s` }]);
      } else if (e.kind === "sweep.done") {
        const d = e as { checked: number; opened: number };
        setDone(d.opened ? `${d.opened} incident${d.opened === 1 ? "" : "s"} opened. Hand one to Warden below.` : `Everything answered. Nothing is wrong.`);
        setBusy(false);
        close();
        router.refresh();
      } else if (e.kind === "error") {
        setDone((e as { message: string }).message);
        setBusy(false);
        close();
      }
    };
    source.onerror = () => {
      close();
      setBusy(false);
      router.refresh();
    };
  };

  return (
    <div className="cn">
      <button type="button" className="btn btn-quiet btn-sm" onClick={run} disabled={busy}>
        {busy ? "Checking…" : label}
      </button>

      {lines.length || done ? (
        <ul className="cn-lines">
          {lines.map((l) => (
            <li key={l.id} className={`cn-line ${l.ok === false ? "is-bad" : "is-ok"}`}>
              <span className="cn-dot" aria-hidden="true" />
              <span className="cn-l">{l.label}</span>
              <span className="cn-d mono">{l.detail}</span>
              {l.ms !== undefined ? <span className="cn-ms mono">{l.ms}ms</span> : null}
            </li>
          ))}
          {done ? <li className="cn-done">{done}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
