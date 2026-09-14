/**
 * THE MACHINES WARDEN CAN REACH, AND THE KEYS IT HOLDS.
 *
 * A form on a web page must never hand a file path to ssh. `-i /etc/shadow` does not read the file
 * back to you, but "does this path exist and parse as a key" is a probe, and a path typed by a
 * stranger is a path the operator never agreed to. So the web never names a key file: it picks from
 * a list the operator configured on the server, by nickname.
 *
 *   WARDEN_SSH_KEYS="prod:/home/ubuntu/.ssh/id_ed25519,staging:/home/ubuntu/.ssh/staging.key"
 *
 * Unset, there are no keys and the web can only register services Warden watches over http — which
 * is a perfectly good product on its own, and the honest default for an instance anyone can reach.
 * The CLI still takes a path directly: whoever runs it already has a shell on the machine.
 */
export interface SshKey {
  /** what a person picks in the UI */
  name: string;
  /** never sent to the browser */
  path: string;
}

export function sshKeys(): SshKey[] {
  return (process.env.WARDEN_SSH_KEYS ?? "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf(":");
      return at === -1 ? null : { name: pair.slice(0, at).trim(), path: pair.slice(at + 1).trim() };
    })
    .filter((k): k is SshKey => !!k && !!k.name && !!k.path);
}

/** The path behind a nickname, or null. The browser sends the name; only the server knows the path. */
export function sshKeyPath(name: string): string | null {
  return sshKeys().find((k) => k.name === name)?.path ?? null;
}

/** The names alone, which is all a page is ever allowed to render. */
export const sshKeyNames = (): string[] => sshKeys().map((k) => k.name);
