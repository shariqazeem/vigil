/**
 * The things, drawn. Thin single-weight outlines on a 48×48 box, no fills, so a node reads as an
 * object at 40px and as a diagram at 140px. They are deliberately plain: this is a safety product,
 * and a cute illustration of a cot in a screen about a cot that can kill a baby would be obscene.
 *
 * `glyphFor` picks by the regulator's own category word first and the label second, and falls back
 * to a plain box — an unrecognised object is still watched, and the drawing says so honestly rather
 * than guessing at a picture.
 */

export type GlyphName = "car" | "dresser" | "monitor" | "bottle" | "cot" | "heater" | "stroller" | "seat" | "toy" | "box";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const PATHS: Record<GlyphName, React.ReactNode> = {
  car: (
    <>
      <path d="M6 30h36M9 30v5M39 30v5" {...S} />
      <path d="M7 30l3.4-8.2A4 4 0 0 1 14.1 19h19.8a4 4 0 0 1 3.7 2.5L41 30" {...S} />
      <path d="M14 19.5 16 13h16l2 6.5" {...S} />
      <circle cx="14.5" cy="30" r="2.6" {...S} />
      <circle cx="33.5" cy="30" r="2.6" {...S} />
    </>
  ),
  dresser: (
    <>
      <rect x="10" y="9" width="28" height="31" rx="1.6" {...S} />
      <path d="M10 19h28M10 29h28M10 40v3M38 40v3" {...S} />
      <path d="M21 14h6M21 24h6M21 34h6" {...S} />
    </>
  ),
  monitor: (
    <>
      <rect x="8" y="10" width="32" height="22" rx="2.4" {...S} />
      <rect x="12" y="14" width="24" height="14" rx="1.2" {...S} />
      <path d="M19 36h10M24 32v4" {...S} />
      <circle cx="24" cy="21" r="2.4" {...S} />
    </>
  ),
  bottle: (
    <>
      <path d="M20 7h8v5.5l3.4 4A6 6 0 0 1 33 20.4V38a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V20.4a6 6 0 0 1 1.6-4.1L20 12.5Z" {...S} />
      <path d="M15 24h18" {...S} />
    </>
  ),
  cot: (
    <>
      <path d="M8 14v24M40 14v24M8 32h32" {...S} />
      <path d="M14 16v14M20 16v14M26 16v14M32 16v14" {...S} />
      <path d="M8 16h32" {...S} />
      <path d="M11 38v3M37 38v3" {...S} />
    </>
  ),
  heater: (
    <>
      <rect x="11" y="12" width="26" height="24" rx="3" {...S} />
      <path d="M17 18v12M24 18v12M31 18v12" {...S} />
      <path d="M15 40h18" {...S} />
    </>
  ),
  stroller: (
    <>
      <path d="M10 26h20a10 10 0 0 0-10-10h-6" {...S} />
      <path d="M10 26 8 12H4" {...S} />
      <path d="M12 26v6M28 26v6" {...S} />
      <circle cx="13" cy="36" r="3.2" {...S} />
      <circle cx="30" cy="36" r="3.2" {...S} />
      <path d="M30 32h-5" {...S} />
    </>
  ),
  seat: (
    <>
      <path d="M16 40V20a8 8 0 0 1 8-8h6" {...S} />
      <path d="M16 40h16" {...S} />
      <path d="M16 28h12" {...S} />
      <path d="M30 12v10" {...S} />
      <path d="M20 20 32 34" {...S} />
    </>
  ),
  toy: (
    <>
      <circle cx="24" cy="24" r="13" {...S} />
      <path d="M24 11v26M11 24h26" {...S} />
    </>
  ),
  box: (
    <>
      <rect x="10" y="13" width="28" height="24" rx="2" {...S} />
      <path d="M10 21h28M24 13v8" {...S} />
    </>
  ),
};

const MATCH: [RegExp, GlyphName][] = [
  [/car seat|child restraint|booster/i, "seat"],
  [/crib|cot|bassinet|play ?yard/i, "cot"],
  [/dresser|chest|clothing storage|bureau|furniture|drawer/i, "dresser"],
  [/monitor|camera|display|screen|laptop|tablet|phone/i, "monitor"],
  [/heater|fan|radiator|humidifier|kettle|air ?fryer|appliance/i, "heater"],
  [/stroller|pram|pushchair|walker|jumper|swing/i, "stroller"],
  [/toy|doll|game|battery|button ?cell/i, "toy"],
  [/supplement|vitamin|melatonin|formula|food|drug|medicine|tablet|gumm/i, "bottle"],
  [/vehicle|car|truck|van|suv|sedan|saloon|coupe|motorcycle/i, "car"],
];

export function glyphNameFor(thing: { kind: string; category?: string | null; label: string; model?: string | null }): GlyphName {
  const hay = [thing.category, thing.label, thing.model].filter(Boolean).join(" ");
  for (const [re, name] of MATCH) if (re.test(hay)) return name;
  if (thing.kind === "vehicle") return "car";
  if (thing.kind === "ingestible") return "bottle";
  return "box";
}

export function Glyph({ name, size = 48 }: { name: GlyphName; size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
