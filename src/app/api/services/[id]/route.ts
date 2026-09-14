import { z } from "zod";
import { canEdit, currentOwner } from "@/lib/auth/session";
import { forgetService, getService, logEvent, renameService, touchService } from "@/lib/db/warden";
import { describePolicy, sanitisePolicy } from "@/lib/ops/policy";
import { confineLocal } from "@/lib/ops/local";
import { no, ok, readJson, text } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CHANGING WHAT WARDEN MAY DO, from the page that shows what it has been doing.
 *
 * `canEdit`, not `canView`: the demo fleet is readable by anyone and writable by nobody. Every
 * change is written to the event log with the policy in one sentence, so "who widened this, and
 * when" is answerable afterwards — which is the least a page that hands an agent more power owes.
 */
const Patch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  matters: z.string().trim().max(200).optional().nullable(),
  repo: z.string().trim().max(300).optional().nullable(),
  process: z.string().trim().max(80).optional().nullable(),
  state: z.enum(["watching", "paused"]).optional(),
  policy: z.unknown().optional(),
});

async function mine(id: string) {
  const service = getService(id);
  if (!service) return { error: no("No such service.", 404) };
  const owner = await currentOwner();
  if (!canEdit(service.ownerKey, owner)) {
    return {
      error: no(
        service.ownerKey === "demo"
          ? "The demo fleet is public to watch and nobody's to change. Register your own service and Warden will do the same for it."
          : "That is not yours to change.",
        403,
      ),
    };
  }
  return { service };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const found = await mine(id);
  if (found.error) return found.error;
  const service = found.service!;

  const parsed = Patch.safeParse(await readJson<unknown>(req));
  if (!parsed.success) return no(parsed.error.issues[0]?.message ?? "Warden could not read that change.", 400);
  const b = parsed.data;

  // The same rule as registration, because editing is another way to arrive at the same place: a
  // service with no ssh key runs everything on Warden's own machine, so it does not get a checkout
  // path or a process name unless the operator has allowed local services.
  if ((b.repo !== undefined || b.process !== undefined) && !service.sshKey) {
    const confined = confineLocal({ repo: b.repo, process: b.process });
    if (confined.refused) return no(confined.refused, 400, b.repo ? "repo" : "process");
  }

  if (b.name !== undefined || b.matters !== undefined || b.repo !== undefined || b.process !== undefined) {
    renameService(id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.matters !== undefined ? { matters: text(b.matters, 200) } : {}),
      ...(b.repo !== undefined ? { repo: text(b.repo, 300) } : {}),
      ...(b.process !== undefined ? { process: text(b.process, 80) } : {}),
    });
  }

  if (b.state) {
    touchService(id, { state: b.state });
    logEvent(id, "human", b.state === "paused" ? "paused" : "resumed", `${service.name} is ${b.state === "paused" ? "no longer" : "being"} watched`);
  }

  if (b.policy !== undefined) {
    const policy = sanitisePolicy(b.policy);
    touchService(id, { policy: JSON.stringify(policy) });
    logEvent(id, "human", "policy.changed", describePolicy(policy));
  }

  return ok({ ok: true, policy: b.policy !== undefined ? sanitisePolicy(b.policy) : undefined });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const found = await mine(id);
  if (found.error) return found.error;
  forgetService(id);
  return ok({ ok: true });
}
