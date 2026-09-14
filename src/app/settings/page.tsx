import Link from "next/link";
import { currentOwner } from "@/lib/auth/session";
import { listChannels, listServices } from "@/lib/db/warden";
import { Channels } from "./channels";
import "./settings.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Where to reach you — Warden",
  description: "Warden wakes you only when the decision is yours. This is how it reaches you.",
};

/**
 * HOW WARDEN REACHES YOU.
 *
 * The promise on the front page is that it wakes you only when the answer is genuinely yours. For a
 * while that was a description of a screen — the run halted and waited for somebody to happen to
 * look at it. This page is what makes the sentence true.
 */
export default async function SettingsPage() {
  const owner = await currentOwner();
  const channels = owner ? listChannels(owner.key) : [];
  const mine = owner ? listServices(owner.key) : [];

  return (
    <main className="st">
      <p className="in-crumb micro">
        <Link href="/">warden</Link> / where to reach you
      </p>

      <header className="st-head">
        <h1 className="st-h1">Where to reach you.</h1>
        <p className="st-lede">
          Warden works alone until the decision is yours. When it stops to ask — or acts and the check still fails — it posts to
          every address here. A Slack or Discord incoming webhook is exactly this, and so is anything you write yourself: it is a
          POST with JSON, and no credential of yours is stored beyond the URL.
        </p>
      </header>

      <Channels
        channels={channels.map((c) => ({
          id: c.id,
          label: c.label,
          // Never render a whole webhook URL: the secret in a Slack hook IS the path.
          host: safeHost(c.url),
          level: c.level,
          lastAt: c.lastAt,
          lastOk: c.lastOk,
          lastNote: c.lastNote,
        }))}
      />

      <section className="st-sec">
        <h2 className="in-h2">What gets sent</h2>
        <ul className="st-when">
          <li>
            <span className="chip is-warn">stopped to ask you</span>
            Warden worked out what to do and your policy says the decision is yours. The run is held open until you answer.
          </li>
          <li>
            <span className="chip is-down">acted, and it is still down</span>
            It did what it was allowed to do and the check it re-ran still fails. It will not call that fixed.
          </li>
          <li>
            <span className="chip is-down">handing this back</span>
            It could not find a cause, or nothing it was allowed to do would help.
          </li>
          <li>
            <span className="chip is-ok">fixed it, and proved it</span>
            Only to addresses set to <em>everything</em>. Something broke, Warden fixed it, and the check that failed passes again.
          </li>
        </ul>
        <p className="st-note">
          The payload carries the service, the title, the body and a link, plus a <code className="mono">text</code> field that
          Slack renders and a <code className="mono">content</code> field that Discord renders — so one address shape reaches both
          without Warden knowing which is which.
        </p>
      </section>

      {mine.length === 0 ? (
        <p className="st-none">
          You have nothing of your own registered yet, so there is nothing to be woken about. <Link href="/new">Point Warden at something</Link> first.
        </p>
      ) : null}
    </main>
  );
}

/** The host, and how long the path is. Enough to tell two hooks apart, not enough to reuse one. */
function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}/…${u.pathname.length > 1 ? ` (${u.pathname.length} characters)` : ""}`;
  } catch {
    return "an address Warden can no longer parse";
  }
}
