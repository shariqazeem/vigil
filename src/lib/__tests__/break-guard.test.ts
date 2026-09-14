import { describe, expect, it } from "vitest";

/**
 * THE SWITCH A VISITOR IS ALLOWED TO TOUCH.
 *
 * "Break it and watch" stops a real process on a real machine at the request of anyone who loads
 * the page. That is the right call for the one service set aside for it and a catastrophic one for
 * either of the others: SAGE belongs to somebody else and is entered in two competitions, and
 * Warden's own console is what the visitor is watching through — stopping it would take the
 * evidence down with the service.
 *
 * The route asks four questions before it touches anything, and this asserts all four, because the
 * cost of getting the environment variable wrong is somebody else's production.
 */
import { breakableService } from "@/lib/demo-break";
import type { Service } from "@/lib/db/schema";

// The real function, not a copy of it: a test that restates the predicate it is guarding proves
// only that two pieces of code agree today.
const isBreakable = (named: string | undefined, services: Svc[]) => breakableService(named, services as unknown as Service[]);

type Svc = { id: string; name: string; ownerKey: string; process: string | null };

const FLEET: Svc[] = [
  { id: "svc_console", name: "Warden's own console", ownerKey: "demo", process: "warden" },
  { id: "svc_vigil", name: "Vigil", ownerKey: "demo", process: "vigil" },
  { id: "svc_sage", name: "SAGE", ownerKey: "demo", process: "sage" },
  { id: "svc_theirs", name: "Somebody's app", ownerKey: "anon:someone", process: "app" },
];

describe("which service a stranger may stop", () => {
  it("allows the one the operator set aside", () => {
    expect(isBreakable("svc_vigil", FLEET)?.name).toBe("Vigil");
    expect(isBreakable("Vigil", FLEET)?.id).toBe("svc_vigil");
  });

  it("refuses Warden's own console, however it is named", () => {
    expect(isBreakable("svc_console", FLEET)).toBeNull();
    expect(isBreakable("Warden's own console", FLEET)).toBeNull();
  });

  it("refuses SAGE, which belongs to somebody else and is entered in two competitions", () => {
    expect(isBreakable("svc_sage", FLEET)).toBeNull();
    expect(isBreakable("SAGE", FLEET)).toBeNull();
  });

  it("refuses a service that is not part of the public fleet at all", () => {
    // Somebody else's registered service is never on this switch, whatever the variable says.
    expect(isBreakable("svc_theirs", FLEET)).toBeNull();
  });

  it("refuses everything when the operator has not set one", () => {
    expect(isBreakable(undefined, FLEET)).toBeNull();
    expect(isBreakable("", FLEET)).toBeNull();
  });

  it("refuses a name that matches nothing rather than falling back to the first service", () => {
    expect(isBreakable("svc_does_not_exist", FLEET)).toBeNull();
  });

  it("refuses a service with no process to stop", () => {
    expect(isBreakable("svc_url_only", [{ id: "svc_url_only", name: "URL only", ownerKey: "demo", process: null }])).toBeNull();
  });
});
