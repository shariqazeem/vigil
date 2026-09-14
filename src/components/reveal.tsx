"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The one piece of scroll motion in the product: a section arrives when you reach it, once, and
 * then stays put. No parallax, no counters spinning up on a timer, nothing that moves while you are
 * trying to read a sentence about a cot that can kill a baby. Reduced motion gets the final state
 * immediately and nothing is ever hidden from a reader who cannot see the transition.
 */
export function Reveal({ children, className = "", as: As = "section" }: { children: React.ReactNode; className?: string; as?: "section" | "div" }) {
  const ref = useRef<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <As ref={ref as never} className={`reveal ${inView ? "is-in" : ""} ${className}`}>
      {children}
    </As>
  );
}
