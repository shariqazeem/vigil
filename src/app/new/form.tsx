"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The registration form. Three groups, in the order a person actually knows the answers:
 * what it is, how to tell it is alright, and what Warden may do about it when it is not.
 *
 * The third group is the one that matters and it is written as three sentences rather than a policy
 * editor, because a person choosing this for the first time has no way to judge whether
 * `redeploy_previous` should be in `ask`. The full policy, operation by operation, is on the
 * service page the moment this is saved — with what each one actually runs next to it.
 */

type Posture = "observe" | "ask" | "may";

const POSTURES: { value: Posture; title: string; body: string }[] = [
  {
    value: "observe",
    title: "Watch only",
    body: "Look at anything — logs, the process table, recent commits — and work out what is wrong. Change nothing, ever. Start here if it is not yours, or you are not ready.",
  },
  {
    value: "ask",
    title: "Ask me first",
    body: "Investigate, work out the fix, and show you the exact command it would run. Then stop and wait. The run is held open until you answer, however long that takes.",
  },
  {
    value: "may",
    title: "Fix what undoes itself",
    body: "Restart it, start it, run the tests — unattended, then re-run the failing check to prove it worked. Anything that does not undo itself still comes to you.",
  },
];

interface Field {
  name: string;
  matters: string;
  url: string;
  expectStatus: string;
  expectContains: string;
  sshKeyName: string;
  host: string;
  repo: string;
  process: string;
  posture: Posture;
}

const EMPTY: Field = {
  name: "",
  matters: "",
  url: "",
  expectStatus: "200",
  expectContains: "",
  sshKeyName: "",
  host: "",
  repo: "",
  process: "",
  posture: "ask",
};

export function NewService({ sshKeys, allowsPrivate, allowsLocal, first }: { sshKeys: string[]; allowsPrivate: boolean; allowsLocal: boolean; first: boolean }) {
  const [f, setF] = useState<Field>(EMPTY);
  const [deep, setDeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const router = useRouter();

  const set = <K extends keyof Field>(k: K, v: Field[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setError((e) => (e?.field === k ? null : e));
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/services", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: f.name,
          matters: f.matters || null,
          url: f.url || null,
          expectStatus: f.expectStatus || 200,
          expectContains: f.expectContains || null,
          sshKeyName: deep && f.sshKeyName ? f.sshKeyName : null,
          host: deep ? f.host || null : null,
          repo: deep ? f.repo || null : null,
          process: deep ? f.process || null : null,
          posture: f.posture,
        }),
      });
      const body = (await res.json()) as { id?: string; error?: string; field?: string };
      if (!res.ok || !body.id) {
        setError({ message: body.error ?? "Warden could not register that.", field: body.field });
        setBusy(false);
        return;
      }
      router.push(`/s/${body.id}?welcome=1`);
      router.refresh();
    } catch {
      setError({ message: "The request did not get through. Check your connection and try again." });
      setBusy(false);
    }
  };

  const errFor = (k: string) => (error?.field === k ? error.message : null);

  return (
    <form className="nw-form" onSubmit={submit} noValidate>
      {/* ── what it is ───────────────────────────────────────────── */}
      <fieldset className="nw-set card">
        <legend className="nw-leg">What is it</legend>

        <label className="nw-field">
          <span className="nw-label">Name</span>
          <input className="nw-in" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="The checkout API" maxLength={60} required autoFocus />
        </label>

        <label className="nw-field">
          <span className="nw-label">
            What breaks for a person when this is down <em>optional</em>
          </span>
          <input
            className="nw-in"
            value={f.matters}
            onChange={(e) => set("matters", e.target.value)}
            placeholder="Nobody can pay us."
            maxLength={200}
          />
          <span className="nw-hint">Warden puts this in front of itself while it works. It is the difference between a restart and a careful one.</span>
        </label>
      </fieldset>

      {/* ── how to tell it is alright ────────────────────────────── */}
      <fieldset className="nw-set card">
        <legend className="nw-leg">How Warden can tell it is alright</legend>

        <label className="nw-field">
          <span className="nw-label">URL to check</span>
          <input
            className={`nw-in ${errFor("url") ? "is-bad" : ""}`}
            value={f.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://example.com/health"
            inputMode="url"
            maxLength={400}
          />
          {errFor("url") ? <span className="nw-err">{errFor("url")}</span> : (
            <span className="nw-hint">
              Asked every five minutes. Two failures in a row open an incident — one blip on a network is not an outage.
              {allowsPrivate ? "" : " This Warden watches public addresses only."}
            </span>
          )}
        </label>

        <div className="nw-row">
          <label className="nw-field nw-narrow">
            <span className="nw-label">Expect status</span>
            <input className="nw-in mono" value={f.expectStatus} onChange={(e) => set("expectStatus", e.target.value)} inputMode="numeric" maxLength={3} />
          </label>
          <label className="nw-field">
            <span className="nw-label">
              And the body contains <em>optional</em>
            </span>
            <input className="nw-in mono" value={f.expectContains} onChange={(e) => set("expectContains", e.target.value)} placeholder="ok" maxLength={200} />
          </label>
        </div>
      </fieldset>

      {/* ── the machine, which is what turns a watch into an operator ── */}
      <fieldset className={`nw-set card ${deep ? "" : "is-shut"}`}>
        <legend className="nw-leg">
          <button type="button" className="nw-toggle" onClick={() => setDeep((d) => !d)} aria-expanded={deep}>
            <span className={`nw-caret ${deep ? "is-open" : ""}`} aria-hidden="true" />
            Where it runs
            <em>{deep ? "" : "optional — but this is what lets Warden fix anything"}</em>
          </button>
        </legend>

        {deep ? (
          <div className="nw-deep">
            {sshKeys.length === 0 ? (
              <p className="nw-note">
                This Warden holds no ssh keys, so it can watch over http but cannot reach a machine. Whoever runs it sets{" "}
                <code className="mono">WARDEN_SSH_KEYS=&quot;prod:/path/to/key&quot;</code> to change that — a form never names a key file.
                {allowsLocal ? null : (
                  <>
                    {" "}
                    A checkout and a process name are not offered either: without a machine of yours to reach, they would point
                    Warden at the host it is running on.
                  </>
                )}
              </p>
            ) : (
              <>
                <div className="nw-row">
                  <label className="nw-field nw-narrow">
                    <span className="nw-label">Key</span>
                    <select className="nw-in" value={f.sshKeyName} onChange={(e) => set("sshKeyName", e.target.value)}>
                      <option value="">none</option>
                      {sshKeys.map((k) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </select>
                  </label>
                  <label className="nw-field">
                    <span className="nw-label">Machine</span>
                    <input
                      className={`nw-in mono ${errFor("host") ? "is-bad" : ""}`}
                      value={f.host}
                      onChange={(e) => set("host", e.target.value)}
                      placeholder="ubuntu@203.0.113.10"
                      maxLength={120}
                    />
                    {errFor("host") ? <span className="nw-err">{errFor("host")}</span> : null}
                  </label>
                </div>
                <span className="nw-hint">
                  Keys are chosen by name from the ones this Warden already holds. The path never comes from the browser, and every
                  command is handed to ssh as arguments — never as a line for a shell to read.
                </span>
              </>
            )}

            {sshKeys.length === 0 && !allowsLocal ? null : (
            <div className="nw-row">
              <label className="nw-field">
                <span className="nw-label">
                  pm2 process name <em>optional</em>
                </span>
                <input className={`nw-in mono ${errFor("process") ? "is-bad" : ""}`} value={f.process} onChange={(e) => set("process", e.target.value)} placeholder="checkout-api" maxLength={80} />
                {errFor("process") ? <span className="nw-err">{errFor("process")}</span> : <span className="nw-hint">Adds a second check, and is what Warden restarts.</span>}
              </label>
              <label className="nw-field">
                <span className="nw-label">
                  Checkout path <em>optional</em>
                </span>
                <input className="nw-in mono" value={f.repo} onChange={(e) => set("repo", e.target.value)} placeholder="/home/ubuntu/checkout-api" maxLength={300} />
                <span className="nw-hint">Lets it read the last commits and the files it names. It cannot read outside this path.</span>
              </label>
            </div>
            )}
          </div>
        ) : null}
      </fieldset>

      {/* ── the decision that matters ────────────────────────────── */}
      <fieldset className="nw-set card nw-posture">
        <legend className="nw-leg">What Warden may do when it is not alright</legend>
        <div className="nw-choices">
          {POSTURES.map((p) => (
            <label key={p.value} className={`nw-choice ${f.posture === p.value ? "is-on" : ""}`}>
              <input type="radio" name="posture" value={p.value} checked={f.posture === p.value} onChange={() => set("posture", p.value)} className="sr-only" />
              <span className="nw-choice-dot" aria-hidden="true" />
              <span className="nw-choice-t">{p.title}</span>
              <span className="nw-choice-b">{p.body}</span>
            </label>
          ))}
        </div>
        <p className="nw-note">
          Four operations — migrating a database, deleting data, rotating a secret, destroying infrastructure — are refused by name
          whatever you pick here, and no policy can turn them on. You can change everything else, operation by operation, on the
          next screen.
        </p>
      </fieldset>

      {error && !error.field ? <p className="nw-error">{error.message}</p> : null}

      <div className="nw-go">
        <button type="submit" className="btn btn-accent nw-submit" disabled={busy || !f.name.trim() || (!f.url.trim() && !f.process.trim())}>
          {busy ? "Registering…" : first ? "Start watching" : "Add it"}
        </button>
        <span className="nw-go-note">
          {first ? "No account, no email. A signed cookie makes this yours." : "It joins your fleet and the next sweep picks it up."}
        </span>
      </div>
    </form>
  );
}
