import Link from "next/link";
import { currentOwner } from "@/lib/auth/session";
import { listServices } from "@/lib/db/warden";
import { sshKeyNames } from "@/lib/ops/hosts";
import { privateTargetsAllowed } from "@/lib/net/targets";
import { localServicesAllowed } from "@/lib/ops/local";
import { NewService } from "./form";
import "./new.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Watch something — Warden",
  description: "Point Warden at something you have running. A URL is enough to start.",
};

/**
 * THE FIRST SCREEN THAT MATTERS.
 *
 * Everything about this page is arranged around one claim: you can hand a running system to an
 * agent in under a minute and still know exactly what you have agreed to. So the form is short, the
 * only required field is how to tell whether the thing is alright, and the decision that actually
 * matters — what Warden may do when it is not — is three sentences, not seventeen switches.
 */
export default async function NewServicePage() {
  const owner = await currentOwner();
  const mine = owner ? listServices(owner.key) : [];

  return (
    <main className="nw">
      <p className="in-crumb micro">
        <Link href="/">warden</Link> / watch something
      </p>

      <header className="nw-head">
        <h1 className="nw-h1">{mine.length ? "Watch something else" : "Point Warden at something you have running."}</h1>
        <p className="nw-lede">
          One URL is enough to begin. Tell it the machine and the process as well and it can read the logs, the process table and
          the last few commits when that URL stops answering — which is the difference between being told something is down and
          being told why.
        </p>
      </header>

      <NewService sshKeys={sshKeyNames()} allowsPrivate={privateTargetsAllowed()} allowsLocal={localServicesAllowed()} first={mine.length === 0} />
    </main>
  );
}
