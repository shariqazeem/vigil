"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface Row {
  id: string;
  label: string;
  host: string;
  level: string;
  lastAt: number | null;
  lastOk: boolean | null;
  lastNote: string | null;
}

/**
 * Adding, testing and removing an address.
 *
 * The test button is not a nicety. A webhook that was pasted wrong fails silently forever, and the
 * failure surfaces during the one incident it was added for. Pressing test sends a real request and
 * prints exactly what came back — and every real delivery is recorded the same way, so a hook that
 * quietly stopped working shows as a red line here instead of looking like a quiet night.
 */
export function Channels({ channels }: { channels: Row[] }) {
  const [adding, setAdding] = useState(channels.length === 0);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [level, setLevel] = useState<"halt" | "all">("halt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const router = useRouter();

  const add = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, url, level }),
    });
    const body = (await res.json()) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "That address was not added.");
    setLabel("");
    setUrl("");
    setAdding(false);
    router.refresh();
  };

  const test = async (id: string) => {
    setTested((t) => ({ ...t, [id]: "sending…" }));
    const res = await fetch(`/api/channels/${id}/test`, { method: "POST" });
    const body = (await res.json()) as { error?: string; detail?: string };
    setTested((t) => ({ ...t, [id]: res.ok ? `sent — it answered ${body.detail}` : (body.error ?? "it did not go through") }));
    router.refresh();
  };

  const remove = async (id: string) => {
    await fetch(`/api/channels/${id}`, { method: "DELETE" });
    router.refresh();
  };

  return (
    <section className="st-sec">
      <h2 className="in-h2">
        Addresses
        {channels.length ? <span className="in-count mono">{channels.length} of 5</span> : null}
      </h2>

      <ul className="st-rows">
        {channels.map((c) => (
          <li key={c.id} className="card st-row">
            <div className="st-row-l">
              <p className="st-row-n">
                {c.label}
                <span className={`chip ${c.level === "all" ? "is-accent" : "is-warn"}`}>{c.level === "all" ? "everything" : "only when it needs you"}</span>
              </p>
              <p className="st-row-u mono">{c.host}</p>
              {c.lastAt ? (
                <p className={`st-row-last ${c.lastOk ? "is-ok" : "is-bad"}`}>
                  last used {ago(c.lastAt)} · {c.lastOk ? "delivered" : "failed"}
                  {c.lastNote ? ` — ${c.lastNote}` : ""}
                </p>
              ) : (
                <p className="st-row-last">never used yet</p>
              )}
              {tested[c.id] ? <p className="st-row-test">{tested[c.id]}</p> : null}
            </div>
            <div className="st-row-go">
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => test(c.id)}>
                Send one now
              </button>
              <button type="button" className="sp-retire" onClick={() => remove(c.id)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="card st-add">
          <label className="nw-field">
            <span className="nw-label">What to call it</span>
            <input className="nw-in" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="our #alerts channel" maxLength={60} />
          </label>
          <label className="nw-field">
            <span className="nw-label">The webhook URL</span>
            <input className="nw-in mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" maxLength={500} />
            <span className="nw-hint">
              In Slack: Apps → Incoming Webhooks → Add to Workspace. In Discord: Channel settings → Integrations → New Webhook. Or
              any URL of your own that accepts a POST.
            </span>
          </label>
          <div className="st-levels">
            <button type="button" className={`pe-seg-b ${level === "halt" ? "is-on is-ask" : ""}`} onClick={() => setLevel("halt")}>
              Only when it needs you
            </button>
            <button type="button" className={`pe-seg-b ${level === "all" ? "is-on is-may" : ""}`} onClick={() => setLevel("all")}>
              Everything, including fixes
            </button>
          </div>
          {error ? <p className="nw-err">{error}</p> : null}
          <div className="sp-adder-go">
            <button type="button" className="btn btn-accent btn-sm" onClick={add} disabled={busy || !label.trim() || !url.trim()}>
              {busy ? "Adding…" : "Add it"}
            </button>
            {channels.length ? (
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setAdding(false); setError(null); }}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-quiet btn-sm st-more" onClick={() => setAdding(true)}>
          Add another address
        </button>
      )}
    </section>
  );
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
