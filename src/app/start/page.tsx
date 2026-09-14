import Link from "next/link";
import { currentOwner } from "@/lib/auth/session";
import { listServices } from "@/lib/db/warden";
import { StartFlow } from "./flow";
// The landing design system, which this page is part of. A page only gets the CSS it imports.
import "../landing.css";
import "./start.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Start watching — Warden",
  description: "A URL is the whole sign-up. No account, no email, nothing to install.",
};

/**
 * THE FIRST MINUTE.
 *
 * Almost every product puts a sign-up here, and almost every sign-up is a tax paid before anybody
 * knows whether the thing works. There is nothing to create: a signed cookie makes a service yours
 * the moment you register one. What this page does instead is tell somebody that plainly, give them
 * the one thing they will wish they had later (a key that carries the identity to another machine),
 * and get out of the way.
 */
export default async function StartPage() {
  const owner = await currentOwner();
  const mine = owner ? listServices(owner.key) : [];

  return (
    <div className="lx sx">
      <nav className="lx-nav">
        <div className="lx-nav-in">
          <Link href="/" className="lx-brand"><span className="lx-mark" aria-hidden />Warden</Link>
          <div className="lx-links">
            <Link href="/fleet" className="lx-link">Watch it live</Link>
            <a href="https://github.com/shariqazeem/warden" className="lx-link" rel="noreferrer">Source</a>
          </div>
        </div>
      </nav>

      <main className="lx-wrap sx-main">
        <header className="sx-head">
          <span className="eyebrow"><i aria-hidden />{mine.length ? `You are watching ${mine.length}` : "No account, no email"}</span>
          <h1 className="display">
            A URL is the
            <br />
            <span className="soft">whole sign-up.</span>
          </h1>
          <p className="lede">
            There is nothing to create. Give Warden something you have running and a signed cookie makes it yours — the service
            appears on your board and the next sweep picks it up. Everything after that is one screen.
          </p>
        </header>

        <StartFlow signedIn={!!owner} name={owner?.name ?? null} services={mine.length} />

        <section className="sx-what">
          <h2 className="h3">What happens next</h2>
          <ol className="sx-steps">
            <li>
              <span className="sx-n">1</span>
              <div>
                <b>It starts checking, every five minutes.</b> Two failures in a row open an incident, because one blip on a
                network is not an outage. An https URL also gets a certificate check, free, at fourteen days&rsquo; notice.
              </div>
            </li>
            <li>
              <span className="sx-n">2</span>
              <div>
                <b>You say what it may do.</b> All seventeen operations on one screen, each with a sentence saying what granting
                it means. Four are refused by name and no policy can turn them on.
              </div>
            </li>
            <li>
              <span className="sx-n">3</span>
              <div>
                <b>It works while you sleep.</b> It investigates, acts inside your policy, and proves the fix by re-running the
                check that failed. It wakes you only when the decision is genuinely yours.
              </div>
            </li>
          </ol>
          <p className="sx-note">
            Want to see it happen before you hand it anything? The <Link href="/fleet">live board</Link> has a button that really
            stops a real service so you can watch the whole loop. It takes about ninety seconds.
          </p>
        </section>
      </main>
    </div>
  );
}
