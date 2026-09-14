import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WAKING SOMEBODY UP.
 *
 * The claim on the front page is that Warden wakes you only when the decision is genuinely yours.
 * For most of this project's life that was a description of a screen: the run halted and waited for
 * a person to happen to open a page. An operator that cannot reach you has not woken you.
 *
 * What has to hold:
 *   a halt reaches every address, a routine fix reaches only the ones that asked for everything
 *   a broken webhook NEVER fails a run — an incident that was fixed stays fixed
 *   every attempt is recorded, so a hook that silently stopped working is visible
 */
const env = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/warden-notify-${process.pid}-${Date.now()}`;
  process.env.WARDEN_DB_PATH = `${dir}/warden.db`;
  process.env.WARDEN_ALLOW_PRIVATE_TARGETS = "1";
  delete (globalThis as { __wardenDb?: unknown }).__wardenDb;
  return { dir };
});

import { rmSync } from "node:fs";
import { addChannel, addService, getChannel, listChannels, retireChannel } from "@/lib/db/warden";
import { OBSERVE_ONLY } from "@/lib/ops/policy";
import { notify } from "@/lib/notify";

afterAll(() => rmSync(env.dir, { recursive: true, force: true }));

const OWNER = "anon:notified";
const sent: { url: string; body: Record<string, unknown> }[] = [];
let reply: () => Response | Promise<Response> = () => new Response("ok", { status: 200 });

beforeEach(() => {
  sent.length = 0;
  reply = () => new Response("ok", { status: 200 });
  for (const c of listChannels(OWNER)) retireChannel(c.id);
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return reply();
  });
});

const service = () => addService({ ownerKey: OWNER, name: "The checkout API", host: "local", policy: OBSERVE_ONLY });

describe("who hears about what", () => {
  it("tells every address when the run has stopped and needs a person", async () => {
    const only = addChannel({ ownerKey: OWNER, label: "phone", url: "http://127.0.0.1:1/a", level: "halt" });
    const all = addChannel({ ownerKey: OWNER, label: "log", url: "http://127.0.0.1:1/b", level: "all" });
    await notify({ level: "halt", serviceId: service().id, title: "stopped and is waiting on you", body: "Approve the restart?" });
    expect(sent).toHaveLength(2);
    expect(getChannel(only.id)!.lastOk).toBe(true);
    expect(getChannel(all.id)!.lastOk).toBe(true);
  });

  it("does not interrupt anybody about something it already fixed", async () => {
    addChannel({ ownerKey: OWNER, label: "phone", url: "http://127.0.0.1:1/a", level: "halt" });
    addChannel({ ownerKey: OWNER, label: "log", url: "http://127.0.0.1:1/b", level: "all" });
    await notify({ level: "all", serviceId: service().id, title: "fixed it, and proved it", body: "back up" });
    expect(sent.map((s) => s.url)).toEqual(["http://127.0.0.1:1/b"]);
  });

  it("tells nobody else's addresses", async () => {
    addChannel({ ownerKey: "anon:a-stranger", label: "theirs", url: "http://127.0.0.1:1/x", level: "all" });
    await notify({ level: "halt", serviceId: service().id, title: "stopped", body: "…" });
    expect(sent).toHaveLength(0);
  });
});

describe("the payload", () => {
  it("carries the fields a person needs and the two fields Slack and Discord render", async () => {
    addChannel({ ownerKey: OWNER, label: "phone", url: "http://127.0.0.1:1/a", level: "halt" });
    await notify({ level: "halt", serviceId: service().id, title: "stopped and is waiting on you", body: "Approve the restart?", url: "https://w.example/i/1" });
    const body = sent[0]!.body;
    expect(body).toMatchObject({ warden: "1", level: "halt", service: "The checkout API", title: "stopped and is waiting on you" });
    // one payload, both receivers, no per-vendor adapter
    expect(String(body.text)).toContain("The checkout API");
    expect(String(body.content)).toContain("Approve the restart?");
    expect(String(body.text)).toContain("https://w.example/i/1");
  });
});

describe("when the address is broken, which is the normal case eventually", () => {
  it("does not throw, so an incident that was fixed stays fixed", async () => {
    addChannel({ ownerKey: OWNER, label: "gone", url: "http://127.0.0.1:1/a", level: "halt" });
    reply = () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(notify({ level: "halt", serviceId: service().id, title: "stopped", body: "…" })).resolves.toBeUndefined();
  });

  it("writes down that it failed, so it is not mistaken for a quiet night", async () => {
    const c = addChannel({ ownerKey: OWNER, label: "gone", url: "http://127.0.0.1:1/a", level: "halt" });
    reply = () => new Response("no such hook", { status: 404 });
    await notify({ level: "halt", serviceId: service().id, title: "stopped", body: "…" });
    const after = getChannel(c.id)!;
    expect(after.lastOk).toBe(false);
    expect(after.lastNote).toContain("404");
    expect(after.lastAt).toBeTruthy();
  });

  it("refuses to post to an address that is no longer allowed, without calling fetch", async () => {
    // The row outlives the form that made it, and the rules can change under it.
    delete process.env.WARDEN_ALLOW_PRIVATE_TARGETS;
    const c = addChannel({ ownerKey: OWNER, label: "metadata", url: "http://169.254.169.254/hook", level: "halt" });
    await notify({ level: "halt", serviceId: service().id, title: "stopped", body: "…" });
    expect(sent).toHaveLength(0);
    expect(getChannel(c.id)!.lastOk).toBe(false);
    process.env.WARDEN_ALLOW_PRIVATE_TARGETS = "1";
  });
});
