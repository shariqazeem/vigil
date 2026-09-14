import { NextResponse } from "next/server";
import { anonymousOwner, currentOwner, ownerCookie, type Owner } from "@/lib/auth/session";

/**
 * The shared shape of every write route.
 *
 * Two things matter here. The first is that a person registering their first service has no
 * identity yet and must not be asked to make one — `ownerForWrite` mints a signed key and hands
 * back the cookie to set, so the sign-up step for this product is pressing the button.
 *
 * The second is that failures are sentences. A route that refuses something tells the person what
 * to do instead, because everything these routes refuse is something they typed.
 */
export interface Fresh {
  owner: Owner;
  /** set on the response when the owner was created by this request */
  minted: boolean;
}

export async function ownerForWrite(): Promise<Fresh> {
  const existing = await currentOwner();
  if (existing) return { owner: existing, minted: false };
  return { owner: anonymousOwner(), minted: true };
}

export function ok<T extends object>(body: T, fresh?: Fresh): NextResponse {
  const res = NextResponse.json(body);
  if (fresh?.minted) res.cookies.set(ownerCookie(fresh.owner));
  return res;
}

/** A refusal a person can act on. `field` lets the form put it under the input that caused it. */
export function no(reason: string, status = 400, field?: string): NextResponse {
  return NextResponse.json({ error: reason, field }, { status });
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Trim, cap, and turn "" into null — what every optional text field on a form needs. */
export const text = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};
