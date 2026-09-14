"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Activity, Bell, LayoutGrid, Plus, Radio, ScrollText } from "lucide-react";
import { Ticker } from "@/components/ticker";
import "./shell.css";

/**
 * THE RAIL — one place, on every screen of the app, from which anything can be reached.
 *
 * It sits at 60px and opens to 236px on hover or focus, so the working surface keeps almost all of
 * the width and the labels are one intention away. Fixed chrome rather than a column in the layout:
 * the incident timeline is the thing people watch, and it should not be squeezed to make room for
 * navigation nobody is looking at.
 *
 * Rendered on app routes only. The landing has its own nav and a different job.
 */
const ITEMS = [
  { href: "/fleet", label: "Fleet", icon: LayoutGrid, match: (p: string) => p === "/fleet" || p.startsWith("/s/") },
  { href: "/incidents", label: "Incidents", icon: Radio, match: (p: string) => p === "/incidents" || p.startsWith("/i/") },
  { href: "/activity", label: "Activity", icon: ScrollText, match: (p: string) => p === "/activity" },
  { href: "/settings", label: "Reach you", icon: Bell, match: (p: string) => p === "/settings" },
];

const APP = ["/fleet", "/incidents", "/activity", "/settings", "/new", "/s/", "/i/"];
export const isAppRoute = (p: string) => APP.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a));

export function Rail({ waiting }: { waiting: number }) {
  const pathname = usePathname() ?? "/";
  const on = isAppRoute(pathname);

  // The page needs room for fixed chrome, and only while there IS fixed chrome. Set on <html> so
  // every page's own container can clear it without each of them knowing about the rail.
  useEffect(() => {
    const root = document.documentElement;
    if (on) root.setAttribute("data-rail", "on");
    else root.removeAttribute("data-rail");
    return () => root.removeAttribute("data-rail");
  }, [on]);

  if (!on) return null;

  return (
    <>
      <Ticker />
      <nav className="rail" aria-label="Warden">
        <Link href="/" className="rail-brand" aria-label="Warden home">
          <span className="rail-mark" aria-hidden />
          <span className="rail-word">Warden</span>
        </Link>

        <div className="rail-items">
          {ITEMS.map(({ href, label, icon: Icon, match }) => (
            <Link key={href} href={href} className={`rail-item${match(pathname) ? " on" : ""}`}>
              <span className="rail-ico" aria-hidden><Icon size={18} strokeWidth={1.9} /></span>
              <span className="rail-label">{label}</span>
              {href === "/incidents" && waiting > 0 ? <span className="rail-count">{waiting}</span> : null}
            </Link>
          ))}
        </div>

        <Link href="/new" className="rail-item rail-add">
          <span className="rail-ico" aria-hidden><Plus size={18} strokeWidth={2.1} /></span>
          <span className="rail-label">Watch something</span>
        </Link>
      </nav>

      {/* A phone has no hover, so the same destinations become a bottom bar. */}
      <nav className="railm" aria-label="Warden">
        {ITEMS.map(({ href, label, icon: Icon, match }) => (
          <Link key={href} href={href} className={`railm-item${match(pathname) ? " on" : ""}`}>
            <Icon size={19} strokeWidth={1.9} />
            <span>{label}</span>
            {href === "/incidents" && waiting > 0 ? <i className="railm-dot" aria-hidden /> : null}
          </Link>
        ))}
        <Link href="/new" className="railm-item">
          <Plus size={19} strokeWidth={2.1} />
          <span>Add</span>
        </Link>
      </nav>
    </>
  );
}

/** The one number that should ever interrupt somebody, shown where they are looking. */
export function WaitingBanner({ waiting, href }: { waiting: number; href: string }) {
  if (waiting < 1) return null;
  return (
    <Link href={href} className="rail-alert">
      <Activity size={15} strokeWidth={2.2} />
      Warden has stopped and is waiting on you
      <span className="rail-alert-go">Answer it →</span>
    </Link>
  );
}
