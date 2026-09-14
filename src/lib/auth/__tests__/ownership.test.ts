import { describe, expect, it } from "vitest";
import { canEdit, canView, decodeOwner, encodeOwner } from "../session";

/**
 * WATCHING IS NOT CHANGING.
 *
 * The public fleet is the product's proof: three real services anyone can open and watch Warden
 * work on, with no sign-up. That only stays safe while "anyone can see this" and "anyone can change
 * this" are different questions — one stranger widening SAGE's policy off OBSERVE_ONLY would point
 * an agent at somebody else's production, which is the single thing this deployment must never do.
 */
const me = { key: "anon:me", kind: "anon" } as const;
const you = { key: "anon:you", kind: "anon" } as const;

describe("the public fleet", () => {
  it("is visible to a stranger with no cookie at all", () => {
    expect(canView("demo", null)).toBe(true);
    expect(canView("demo", you)).toBe(true);
  });

  it("is editable by nobody — not a stranger, not a signed-in visitor", () => {
    expect(canEdit("demo", null)).toBe(false);
    expect(canEdit("demo", you)).toBe(false);
    expect(canEdit("demo", me)).toBe(false);
  });
});

describe("something of your own", () => {
  it("is yours to see and yours to change", () => {
    expect(canView(me.key, me)).toBe(true);
    expect(canEdit(me.key, me)).toBe(true);
  });

  it("is neither, to anybody else", () => {
    for (const other of [null, you]) {
      expect(canView(me.key, other)).toBe(false);
      expect(canEdit(me.key, other)).toBe(false);
    }
  });
});

describe("the cookie that decides all of it", () => {
  it("round-trips", () => {
    expect(decodeOwner(encodeOwner(me))).toEqual(me);
  });

  it("refuses one whose payload was edited to claim someone else's key", () => {
    const forged = Buffer.from(JSON.stringify({ key: "demo", kind: "anon" }), "utf8").toString("base64url");
    const [, signature] = encodeOwner(me).split(".");
    expect(decodeOwner(`${forged}.${signature}`)).toBeNull();
  });

  it("refuses a missing, empty or malformed cookie rather than guessing", () => {
    for (const raw of [undefined, "", "nonsense", "a.b", `${encodeOwner(me).split(".")[0]}.`]) {
      expect(decodeOwner(raw)).toBeNull();
    }
  });
});
