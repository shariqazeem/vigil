"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The button that makes the rest of this page believable.
 *
 * A working operator has a boring board, so a visitor is otherwise asked to take the interesting
 * part on trust. This stops a real service on a real machine and then shows Warden's own checks
 * noticing — every line of which is a real probe with a real answer — before handing them to the
 * incident, where the agent does the rest in front of them.
 */
export function BreakIt({ name }: { name: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const es = useRef<EventSource | null>(null);
  const router = useRouter();

  const close = useCallback(() => {
    es.current?.close();
    es.current = null;
  }, []);

  const go = () => {
    close();
    setLines([]);
    setError(null);
    setBusy(true);
    const source = new EventSource("/api/demo/break");
    es.current = source;
    source.onmessage = (m) => {
      const e = JSON.parse(m.data) as { kind: string; message?: string; label?: string; ok?: boolean; detail?: string; incidentId?: string; title?: string; symptom?: string };
      if (e.kind === "note") setLines((x) => [...x, e.message!]);
      else if (e.kind === "probe.done") setLines((x) => [...x, `${e.ok ? "✓" : "✗"} ${e.label} — ${e.detail}`]);
      else if (e.kind === "incident.open") setLines((x) => [...x, `incident opened: ${e.symptom}`]);
      else if (e.kind === "ready") {
        close();
        router.push(`/i/${e.incidentId}?go=1`);
        router.refresh();
      } else if (e.kind === "error") {
        setError(e.message!);
        setBusy(false);
        close();
      }
    };
    source.onerror = () => {
      close();
      setBusy(false);
    };
  };

  return (
    <div className="bk card">
      <p className="micro bk-k">Watch the whole thing happen</p>
      <p className="bk-t">The board is green, which is the product working and terrible television.</p>
      <p className="bk-b">
        So break it. This really runs <code className="mono">pm2 stop {name.toLowerCase()}</code> on the machine — the same command a
        person would type, not a simulation and not a seeded row. Warden&rsquo;s own checks then notice, an incident opens, and you
        watch it investigate and commit to a cause. What happens next is not its decision: the policy for this service either lets
        it act — in which case it acts, re-runs the check that failed, and closes the incident on the reading — or stops the run and
        asks you, in which case the button to answer is right there and the run picks up from where it stopped.
      </p>

      {!armed && !busy ? (
        <button type="button" className="btn btn-accent" onClick={() => setArmed(true)}>
          Break {name} on purpose
        </button>
      ) : null}

      {armed && !busy ? (
        <div className="bk-sure">
          <span className="bk-sure-t">This takes {name} down for about a minute. Warden puts it back.</span>
          <button type="button" className="btn btn-accent btn-sm" onClick={go}>
            Do it
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setArmed(false)}>
            Leave it alone
          </button>
        </div>
      ) : null}

      {busy ? <p className="bk-busy">Working — do not reload.</p> : null}

      {lines.length ? (
        <ul className="bk-lines">
          {lines.map((l, i) => (
            <li key={i} className="mono">{l}</li>
          ))}
        </ul>
      ) : null}

      {error ? <p className="bk-err">{error}</p> : null}
    </div>
  );
}
