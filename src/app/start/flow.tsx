"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Copy, KeyRound } from "lucide-react";

/**
 * Three doors, and the first one is the honest default.
 *
 * Most people should press "point it at something" and never think about identity again. The other
 * two exist for the two moments when the absence of an account actually costs something: carrying
 * it to a second machine, and coming back to a browser whose cookies were cleared.
 */
type Mode = "idle" | "keying" | "restoring";

export function StartFlow({ signedIn, name, services }: { signedIn: boolean; name: string | null; services: number }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [label, setLabel] = useState(name ?? "");
  const [key, setKey] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ name: string | null; services: number } | null>(null);
  const router = useRouter();

  const claim = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", name: label.trim() || undefined }),
    });
    const body = (await res.json()) as { key?: string; error?: string };
    setBusy(false);
    if (!res.ok || !body.key) return setError(body.error ?? "Warden could not issue a key.");
    setIssued(body.key);
    router.refresh();
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/identity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore", key }),
    });
    const body = (await res.json()) as { error?: string; name?: string | null; services?: number };
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "That key was not accepted.");
    setRestored({ name: body.name ?? null, services: body.services ?? 0 });
    router.refresh();
  };

  if (issued) {
    return (
      <div className="sx-card sx-issued">
        <span className="eyebrow"><i aria-hidden />Written down once</span>
        <h2 className="h3">This is how you get back in.</h2>
        <p>
          Warden has no password to reset and no email to send, so this string is the whole of it. Keep it somewhere you keep
          secrets: anyone holding it is you, and it is not shown again.
        </p>
        <pre className="well sx-key">{issued}</pre>
        <div className="sx-row">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={async () => {
              await navigator.clipboard.writeText(issued).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2200);
            }}
          >
            {copied ? <><Check size={16} strokeWidth={2.2} /> Copied</> : <><Copy size={16} strokeWidth={2} /> Copy it</>}
          </button>
          <Link href="/new" className="btn btn-accent">
            Now point it at something <ArrowRight size={16} strokeWidth={2.2} />
          </Link>
        </div>
      </div>
    );
  }

  if (restored) {
    return (
      <div className="sx-card sx-issued">
        <span className="eyebrow"><i aria-hidden />Signed back in</span>
        <h2 className="h3">{restored.name ? `Welcome back, ${restored.name}.` : "Welcome back."}</h2>
        <p>
          {restored.services === 0
            ? "That key is yours, and it has nothing registered under it yet."
            : `Warden is watching ${restored.services} service${restored.services === 1 ? "" : "s"} for you.`}
        </p>
        <div className="sx-row">
          <Link href="/fleet" className="btn btn-accent">Go to your board <ArrowRight size={16} strokeWidth={2.2} /></Link>
          <Link href="/new" className="btn btn-quiet">Watch something else</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="sx-doors">
      <Link href="/new" className="sx-door sx-door-main">
        <span className="sx-door-k">Start here</span>
        <span className="h3">Point it at something you have running</span>
        <span className="sx-door-b">
          A name and a URL. That is the registration — no account is created because there is nothing to create.
          {services > 0 ? ` You already have ${services}.` : ""}
        </span>
        <span className="sx-door-go">Register a service <ArrowRight size={16} strokeWidth={2.2} /></span>
      </Link>

      <div className="sx-door-col">
        <div className={`sx-door sx-door-sm ${mode === "keying" ? "is-open" : ""}`}>
          <button type="button" className="sx-door-hit" onClick={() => setMode(mode === "keying" ? "idle" : "keying")} aria-expanded={mode === "keying"}>
            <span className="sx-door-k"><KeyRound size={13} strokeWidth={2} /> Keep it</span>
            <span className="sx-door-t">Get a key that carries this to another machine</span>
          </button>
          {mode === "keying" ? (
            <div className="sx-door-body">
              <p>
                {signedIn
                  ? "Warden already knows you on this browser. A key is that same identity written down, so a cleared cookie or a second laptop is not the end of it."
                  : "This creates an identity on this browser and hands you the string that is it. Nothing is emailed anywhere."}
              </p>
              <label className="nw-field">
                <span className="nw-label">What should Warden call you? <em>optional</em></span>
                <input className="nw-in" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Shariq" maxLength={40} />
              </label>
              {error ? <p className="nw-err">{error}</p> : null}
              <button type="button" className="btn btn-accent btn-sm" onClick={claim} disabled={busy}>
                {busy ? "Issuing…" : "Issue my key"}
              </button>
            </div>
          ) : null}
        </div>

        <div className={`sx-door sx-door-sm ${mode === "restoring" ? "is-open" : ""}`}>
          <button type="button" className="sx-door-hit" onClick={() => setMode(mode === "restoring" ? "idle" : "restoring")} aria-expanded={mode === "restoring"}>
            <span className="sx-door-k"><ArrowRight size={13} strokeWidth={2} /> Come back</span>
            <span className="sx-door-t">I have a key already</span>
          </button>
          {mode === "restoring" ? (
            <div className="sx-door-body">
              <p>Paste it and this browser becomes that identity again, with everything registered under it.</p>
              <label className="nw-field">
                <span className="nw-label">Your recovery key</span>
                <input className="nw-in mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="eyJr…" maxLength={600} />
              </label>
              {error ? <p className="nw-err">{error}</p> : null}
              <button type="button" className="btn btn-accent btn-sm" onClick={restore} disabled={busy || !key.trim()}>
                {busy ? "Checking…" : "Sign back in"}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
