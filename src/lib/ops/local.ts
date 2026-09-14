/**
 * WHETHER THE WEB MAY REGISTER A SERVICE ON THE MACHINE WARDEN ITSELF RUNS ON.
 *
 * It may not, by default, and this file exists because the opposite was true for about an hour.
 *
 * A service with no ssh key runs its operations locally — which is correct and useful when the
 * person registering it owns the machine, and catastrophic when they are a stranger on the
 * internet. `repo` and `process` are theirs to choose, so a registration of
 * {repo: "/home/ubuntu/warden", process: "warden"} points `read_file` at Warden's own checkout,
 * where the .env is, and `pm2_restart` at Warden itself. Path containment does not help: the
 * containment is relative to a repo the attacker named.
 *
 * So a web registration gets the local machine only when the operator has said so. The CLI is
 * unaffected — whoever runs it already has a shell on the box, and that is exactly the difference.
 */
export const localServicesAllowed = (): boolean => process.env.WARDEN_ALLOW_LOCAL_SERVICES === "1";

export interface LocalVerdict {
  /** the fields that survive, with everything local stripped when it is not permitted */
  repo: string | null;
  process: string | null;
  nodeBin: string | null;
  /** set when something was asked for and refused, so the caller can say so rather than ignore it */
  refused: string | null;
}

/**
 * What a service registered without an ssh key is allowed to be. With local services permitted it
 * keeps what it was given; without, it is an http watch and nothing else — which is a real product
 * and an honest one, rather than a quiet downgrade.
 */
export function confineLocal(input: { repo?: string | null; process?: string | null; nodeBin?: string | null }): LocalVerdict {
  if (localServicesAllowed()) {
    return { repo: input.repo ?? null, process: input.process ?? null, nodeBin: input.nodeBin ?? null, refused: null };
  }
  const asked = [input.repo && "a checkout path", input.process && "a process name"].filter(Boolean);
  return {
    repo: null,
    process: null,
    nodeBin: null,
    refused: asked.length
      ? `This Warden watches things over the network, not the machine it runs on, so ${asked.join(" and ")} cannot be part of a service registered here: ${asked.length > 1 ? "they" : "it"} would point Warden at its own host. Give it a machine of yours to reach instead, or run your own Warden with WARDEN_ALLOW_LOCAL_SERVICES=1.`
      : null,
  };
}

/**
 * Whether Warden has anywhere to run an operation for this service other than the URL.
 *
 * A checkout, a process name, or a machine to reach. With none of them, `execute()` refuses every
 * operation except `http_probe` — so the policy may say what it likes and nothing but the check
 * itself can happen.
 */
export const hasMachine = (s: { host: string; repo?: string | null; process?: string | null }): boolean =>
  !!s.process || !!s.repo || (s.host !== "local" && !!s.host);

export interface Stance {
  label: string;
  tone: "unknown" | "warn" | "accent";
}

/**
 * The three words on a service card — from the policy AND from whether there is anything for the
 * policy to be about. A card reading "may act" above a page explaining that Warden cannot touch
 * this service is the product contradicting itself, and the card is the half people read.
 */
export function stanceOf(service: { host: string; repo?: string | null; process?: string | null }, posture: { label: string; tone: Stance["tone"] }): Stance {
  return hasMachine(service) ? posture : { label: "network only", tone: "unknown" };
}
