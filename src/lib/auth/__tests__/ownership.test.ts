import { describe, expect, it } from "vitest";
import { canEdit, canView, decodeOwner, encodeOwner, fromRecoveryKey, recoveryKey } from "../session";

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

/**
 * THE RECOVERY KEY.
 *
 * There is no account and no password, which is a good trade right up until somebody clears their
 * cookies or opens Warden on a second machine — at which point their services were simply
 * unreachable. The key is the cookie written down: hand it back and you are yourself again.
 *
 * Which means it is exactly as powerful as the cookie, and the two things that matter are that a
 * genuine one restores everything and a tampered one restores nothing.
 */
describe("carrying an identity to another machine", () => {
  it("round-trips the whole identity, name included", () => {
    const named = { key: "anon:me", kind: "anon", name: "Shariq" } as const;
    const back = fromRecoveryKey(recoveryKey(named));
    expect(back).toEqual(named);
    expect(canEdit(named.key, back)).toBe(true);
  });

  it("is the cookie, so it grants exactly what the cookie grants and no more", () => {
    const back = fromRecoveryKey(recoveryKey(me))!;
    expect(canEdit(me.key, back)).toBe(true);
    expect(canEdit("demo", back)).toBe(false);
    expect(canEdit(you.key, back)).toBe(false);
  });

  it("refuses a key whose payload was edited to claim another identity", () => {
    const real = recoveryKey(me);
    const forgedPayload = Buffer.from(JSON.stringify({ key: you.key, kind: "anon" }), "utf8").toString("base64url");
    expect(fromRecoveryKey(`${forgedPayload}.${real.split(".")[1]}`)).toBeNull();
  });

  it("refuses noise, truncation and an empty string rather than minting somebody", () => {
    const real = recoveryKey(me);
    for (const bad of ["", "   ", "not-a-key", real.slice(0, -4), real.replace(".", ""), `${real}x`]) {
      expect(fromRecoveryKey(bad), bad.slice(0, 20)).toBeNull();
    }
  });

  it("tolerates the whitespace a paste brings with it", () => {
    expect(fromRecoveryKey(`  ${recoveryKey(me)}\n`)).toEqual(me);
  });

  it("caps a name rather than storing whatever was sent", () => {
    const long = { key: "anon:me", kind: "anon", name: "x".repeat(200) } as const;
    expect(fromRecoveryKey(recoveryKey(long))!.name!.length).toBe(40);
  });
});
