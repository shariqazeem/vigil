"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Policy } from "@/lib/ops/policy";

/**
 * The parts of a service page you can change.
 *
 * The policy editor is the centre of this product, so it is built to be read rather than merely
 * operated: every operation carries the sentence that says what granting it means, the four
 * forbidden ones are shown locked rather than hidden, and nothing is saved until you press save —
 * an agent's permissions should not change because a finger slipped on a toggle.
 */

export interface Op {
  name: string;
  risk: string;
  does: string;
}

type Stance = "may" | "ask" | "never";

const STANCE: { value: Stance; label: string; hint: string }[] = [
  { value: "may", label: "May", hint: "does it, tells you after" },
  { value: "ask", label: "Ask", hint: "stops the run and waits for you" },
  { value: "never", label: "Never", hint: "refused, naming the rule" },
];

const stanceOf = (p: Policy, op: string): Stance => (p.never.includes(op) ? "never" : p.ask.includes(op) ? "ask" : p.may.includes(op) ? "may" : "ask");

function withStance(p: Policy, op: string, next: Stance): Policy {
  const strip = (xs: string[]) => xs.filter((x) => x !== op);
  const base = { ...p, may: strip(p.may), ask: strip(p.ask), never: strip(p.never) };
  return { ...base, [next]: [...base[next], op] };
}

export function PolicyEditor({ serviceId, ops, policy: initial }: { serviceId: string; ops: Op[]; policy: Policy }) {
  const [policy, setPolicy] = useState<Policy>(initial);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const dirty = useMemo(() => JSON.stringify(policy) !== JSON.stringify(initial), [policy, initial]);

  const change = (op: string, next: Stance) => {
    setPolicy((p) => withStance(p, op, next));
    setSaved(false);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/services/${serviceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      const body = (await res.json()) as { error?: string; policy?: Policy };
      if (!res.ok) {
        setError(body.error ?? "That change was not saved.");
      } else {
        if (body.policy) setPolicy(body.policy);
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("The request did not get through.");
    }
    setBusy(false);
  };

  return (
    <div className="pe">
      <div className="pe-caps card">
        <label className="pe-cap">
          <span className="pe-cap-n">At most</span>
          <input
            className="pe-num mono"
            type="number"
            min={0}
            max={20}
            value={policy.maxActionsPerIncident}
            onChange={(e) => { setPolicy((p) => ({ ...p, maxActionsPerIncident: clamp(e.target.value, 0, 20) })); setSaved(false); }}
          />
          <span className="pe-cap-u">action{policy.maxActionsPerIncident === 1 ? "" : "s"} on one incident, then it comes back to you</span>
        </label>
        <label className="pe-cap">
          <span className="pe-cap-n">And no acting twice within</span>
          <input
            className="pe-num mono"
            type="number"
            min={0}
            max={1440}
            value={policy.cooldownMinutes}
            onChange={(e) => { setPolicy((p) => ({ ...p, cooldownMinutes: clamp(e.target.value, 0, 1440) })); setSaved(false); }}
          />
          <span className="pe-cap-u">minutes — restarting in a loop is not a fix</span>
        </label>
        <label className="pe-cap pe-cap-note">
          <span className="pe-cap-n">In your words</span>
          <input
            className="pe-note"
            value={policy.note}
            maxLength={400}
            placeholder="Restart it if it is just stopped. Ask me before anything else."
            onChange={(e) => { setPolicy((p) => ({ ...p, note: e.target.value })); setSaved(false); }}
          />
        </label>
      </div>

      <ul className="pe-ops">
        {ops.map((o) => {
          const forbidden = o.risk === "forbidden";
          const current = stanceOf(policy, o.name);
          return (
            <li key={o.name} className={`pe-op card ${forbidden ? "is-locked" : ""}`}>
              <div className="pe-op-l">
                <p className="pe-op-n mono">
                  {o.name}
                  <span className={`chip ${o.risk === "read" ? "is-unknown" : o.risk === "reversible" ? "is-accent" : o.risk === "disruptive" ? "is-warn" : "is-down"}`}>{o.risk}</span>
                </p>
                <p className="pe-op-d">{o.does}</p>
              </div>
              {forbidden ? (
                <span className="pe-locked chip is-down">never, under any policy</span>
              ) : (
                <div className="pe-seg" role="group" aria-label={`what Warden may do with ${o.name}`}>
                  {STANCE.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      title={s.hint}
                      className={`pe-seg-b is-${s.value} ${current === s.value ? "is-on" : ""}`}
                      aria-pressed={current === s.value}
                      onClick={() => change(o.name, s.value)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className={`pe-bar ${dirty ? "is-up" : ""}`}>
        <span className="pe-bar-t">
          {error ? <span className="pe-bad">{error}</span> : dirty ? "Unsaved changes to what Warden may do here." : saved ? "Saved." : ""}
        </span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setPolicy(initial); setError(null); }} disabled={!dirty || busy}>
          Undo
        </button>
        <button type="button" className="btn btn-accent btn-sm" onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save policy"}
        </button>
      </div>
    </div>
  );
}

const clamp = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || 0));

/* ── checks ───────────────────────────────────────────────────────── */

export function ProbeAdder({ serviceId, hasProcess }: { serviceId: string; hasProcess: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"http" | "tls" | "process">("http");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [process, setProcess] = useState("");
  const [expectStatus, setExpectStatus] = useState("200");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const add = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/services/${serviceId}/probes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind,
        label: label || (kind === "http" ? "the site answers" : kind === "tls" ? "the certificate is not about to expire" : "the process is up"),
        url,
        process,
        expectStatus,
      }),
    });
    const body = (await res.json()) as { error?: string };
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "That check was not added.");
    setOpen(false);
    setLabel("");
    setUrl("");
    setProcess("");
    router.refresh();
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-quiet btn-sm sp-add" onClick={() => setOpen(true)}>
        Add a check
      </button>
    );
  }

  return (
    <div className="card sp-adder">
      <div className="sp-adder-kinds">
        <button type="button" className={`pe-seg-b ${kind === "http" ? "is-on is-may" : ""}`} onClick={() => setKind("http")}>
          A URL answers
        </button>
        <button type="button" className={`pe-seg-b ${kind === "tls" ? "is-on is-may" : ""}`} onClick={() => setKind("tls")}>
          Its certificate is not about to expire
        </button>
        <button type="button" className={`pe-seg-b ${kind === "process" ? "is-on is-may" : ""}`} onClick={() => setKind("process")} disabled={!hasProcess}>
          A process is up
        </button>
      </div>
      <input className="nw-in" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What this check is called" maxLength={60} />
      {kind === "http" ? (
        <div className="nw-row">
          <input className="nw-in mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/health" maxLength={400} />
          <input className="nw-in mono nw-narrow" value={expectStatus} onChange={(e) => setExpectStatus(e.target.value)} placeholder="200" maxLength={3} />
        </div>
      ) : kind === "tls" ? (
        <>
          <input className="nw-in mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/" maxLength={400} />
          <span className="nw-hint">
            Asked every six hours, and it fails while there are still fourteen days left — which is the point. Warden cannot renew
            a certificate and nothing in its catalogue pretends it can; it tells you the date and the issuer, in time to do
            something about it.
          </span>
        </>
      ) : (
        <input className="nw-in mono" value={process} onChange={(e) => setProcess(e.target.value)} placeholder="the pm2 process name" maxLength={80} />
      )}
      {error ? <p className="nw-err">{error}</p> : null}
      <div className="sp-adder-go">
        <button type="button" className="btn btn-accent btn-sm" onClick={add} disabled={busy}>
          {busy ? "Adding…" : "Add it"}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setOpen(false); setError(null); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function RetireProbe({ probeId, label }: { probeId: string; label: string }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const go = async () => {
    setBusy(true);
    await fetch(`/api/probes/${probeId}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  };

  if (!sure) {
    return (
      <button type="button" className="sp-retire" onClick={() => setSure(true)} aria-label={`Retire ${label}`}>
        Retire
      </button>
    );
  }
  return (
    <span className="sp-retire-sure">
      <button type="button" className="sp-retire is-bad" onClick={go} disabled={busy}>
        {busy ? "…" : "Retire it"}
      </button>
      <button type="button" className="sp-retire" onClick={() => setSure(false)}>
        Keep
      </button>
    </span>
  );
}

/* ── stop watching ────────────────────────────────────────────────── */

/**
 * Renaming, and saying what breaks for a person when this is down. The second field is not
 * decoration: Warden puts it in front of itself while it works, and "nobody can pay us" and
 * "an internal dashboard three people use" earn different care from the same agent.
 */
export function ServiceDetails({ serviceId, name, matters }: { serviceId: string; name: string; matters: string | null }) {
  const [n, setN] = useState(name);
  const [m, setM] = useState(matters ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const router = useRouter();
  const dirty = n.trim() !== name || m.trim() !== (matters ?? "");

  const save = async () => {
    setBusy(true);
    await fetch(`/api/services/${serviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: n.trim(), matters: m.trim() || null }),
    });
    setBusy(false);
    setSaved(true);
    router.refresh();
  };

  return (
    <div className="card sp-details">
      <label className="nw-field">
        <span className="nw-label">Name</span>
        <input className="nw-in" value={n} onChange={(e) => { setN(e.target.value); setSaved(false); }} maxLength={60} />
      </label>
      <label className="nw-field">
        <span className="nw-label">What breaks for a person when this is down</span>
        <input className="nw-in" value={m} onChange={(e) => { setM(e.target.value); setSaved(false); }} maxLength={200} placeholder="Nobody can pay us." />
        <span className="nw-hint">Warden reads this before it decides anything.</span>
      </label>
      <div className="sp-adder-go">
        <button type="button" className="btn btn-accent btn-sm" onClick={save} disabled={busy || !dirty || !n.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && !dirty ? <span className="sp-saved">Saved.</span> : null}
      </div>
    </div>
  );
}

export function ServiceSettings({ serviceId, name, paused }: { serviceId: string; name: string; paused: boolean }) {
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const pause = async () => {
    setBusy(true);
    await fetch(`/api/services/${serviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: paused ? "watching" : "paused" }),
    });
    setBusy(false);
    router.refresh();
  };

  const remove = async () => {
    setBusy(true);
    const res = await fetch(`/api/services/${serviceId}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      router.push("/");
      router.refresh();
    }
  };

  return (
    <div className="sp-danger">
      <button type="button" className="btn btn-quiet btn-sm" onClick={pause} disabled={busy}>
        {paused ? "Start watching again" : "Pause the watch"}
      </button>
      {open ? (
        <span className="sp-danger-sure">
          <input
            className="nw-in mono sp-danger-in"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={`type ${name} to confirm`}
            aria-label={`type ${name} to confirm`}
          />
          <button type="button" className="btn btn-danger btn-sm" onClick={remove} disabled={busy || confirm !== name}>
            Delete it and its history
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setOpen(false); setConfirm(""); }}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="sp-retire" onClick={() => setOpen(true)}>
          Stop watching and delete
        </button>
      )}
    </div>
  );
}
