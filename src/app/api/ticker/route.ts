import { NextResponse } from "next/server";
import { tickerLines } from "@/components/ticker-lines";

export const dynamic = "force-dynamic";

/** The last twelve things that really happened across the demo fleet, in plain words. */
export async function GET() {
  return NextResponse.json({ lines: tickerLines() });
}
