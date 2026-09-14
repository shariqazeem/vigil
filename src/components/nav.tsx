import Link from "next/link";
import { currentOwner } from "@/lib/auth/session";
import { listServices, pendingDecisions } from "@/lib/db/warden";

/**
 * The bar at the top of everything.
 *
 * It carries one number and it is the only number in this product that should ever make somebody
 * stop what they are doing: how many runs are halted waiting for an answer. Everything else Warden
 * does is meant to be found later, not now.
 */
export async function Nav() {
  const owner = await currentOwner();
  const mine = owner ? listServices(owner.key) : [];
  const waiting = pendingDecisions().filter((d) => d.serviceId);

  return (
    <nav className="nav">
      <div className="nav-in">
        <Link href="/" className="nav-brand">
          <span className="nav-mark" aria-hidden="true" />
          <span className="nav-word">Warden</span>
        </Link>

        <div className="nav-links">
          <Link href="/" className="nav-link">Fleet</Link>
          <Link href="/activity" className="nav-link">Activity</Link>
          <Link href="/settings" className="nav-link">Reach&nbsp;you</Link>
          {waiting.length > 0 ? (
            <Link href="/#waiting" className="nav-link is-waiting">
              Waiting
              <span className="nav-count">{waiting.length}</span>
            </Link>
          ) : null}
        </div>

        <Link href="/new" className="btn btn-sm nav-add">
          {/* The long form is the one that reads well; the short one is what fits a phone. */}
          <span className="nav-add-long">{mine.length ? "Watch something else" : "Watch something"}</span>
          <span className="nav-add-short" aria-hidden="true">Watch</span>
        </Link>
      </div>
    </nav>
  );
}
