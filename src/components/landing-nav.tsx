"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

/**
 * The floating landing navigation — a compact capsule that stays out of the way. Four destinations
 * and one door. On a phone the links collapse into a real toggled sheet, not a scaled-down bar, and
 * the door is always reachable.
 */
const LINKS = [
  { href: "#how", label: "How it works" },
  { href: "#boundaries", label: "What it may do" },
  { href: "/fleet", label: "Watch it live" },
  { href: "https://github.com/shariqazeem/warden", label: "Source" },
];

export function LandingNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="lx-nav" data-open={open ? "1" : "0"}>
      <div className="lx-nav-in">
        <Link href="/" className="lx-brand" aria-label="Warden home">
          <span className="lx-mark" aria-hidden />
          Warden
        </Link>
        <nav className="lx-links" aria-label="Primary">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="lx-link" rel={l.href.startsWith("http") ? "noreferrer" : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <Link href="/start" className="btn btn-sm lx-nav-cta">Start watching</Link>
        <button
          type="button"
          className="lx-burger"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>
      {open ? (
        <div className="lx-sheet">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
          <Link href="/start" className="btn btn-accent lx-sheet-cta" onClick={() => setOpen(false)}>
            Start watching
          </Link>
        </div>
      ) : null}
    </header>
  );
}
