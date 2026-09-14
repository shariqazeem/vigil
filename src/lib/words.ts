/**
 * THE VOCABULARY — every word the product says about an operation, a risk, a verdict or a stance,
 * in one place, in plain English.
 *
 * The catalogue names operations for the machine (`pm2_restart`, `call_hook`). A person reading
 * the board should never have to decode one. Each name has exactly one sentence-fragment here, and
 * a test holds this list and the catalogue together, because two lists that must agree drift.
 *
 * Rules for the words: no underscores, no "policy", "probe", "sweep", "incident" or "operation".
 * The product has rules, checks, rounds, problems and actions.
 */

const OP_WORDS: Record<string, string> = {
  http_probe: "load the page",
  tls_expiry: "check the certificate",
  dns_lookup: "look up the name",
  http_headers: "ask what answers",
  pm2_list: "list the processes",
  pm2_logs: "read the log",
  git_log: "read recent commits",
  git_show: "read one commit",
  read_file: "read a file",
  grep_repo: "search the code",
  disk_free: "check disk space",
  pm2_restart: "restart the process",
  pm2_start: "start the process",
  run_tests: "run the tests",
  call_hook: "call the deploy hook",
  redeploy_previous: "roll back to the last deploy",
  db_migrate: "run a migration",
  delete_data: "delete data",
  rotate_secret: "rotate a secret",
  destroy_infra: "destroy infrastructure",
};

/** "pm2_restart" → "restart the process". Unknown names come back as themselves, de-underscored. */
export function opWord(name: string): string {
  return OP_WORDS[name] ?? name.replace(/_/g, " ");
}

/** exported for the drift test */
export const OP_WORD_NAMES = Object.keys(OP_WORDS);

const RISK_WORDS: Record<string, string> = {
  read: "looks only",
  reversible: "undoes itself",
  disruptive: "disruptive",
  forbidden: "never, for anyone",
};

/** "reversible" → "undoes itself" */
export function riskWord(risk: string): string {
  return RISK_WORDS[risk] ?? risk;
}

const VERDICT_WORDS: Record<string, string> = {
  allow: "did it",
  ask: "asked you",
  refuse: "refused",
};

/** "allow" → "did it" — past tense, because a verdict is only ever shown after the fact. */
export function verdictWord(verdict: string): string {
  return VERDICT_WORDS[verdict] ?? verdict;
}

const STANCE_WORDS: Record<string, string> = {
  may: "may",
  ask: "asks first",
  never: "never",
};

/** What a rule says about one action, as the editor shows it. */
export function stanceWord(stance: string): string {
  return STANCE_WORDS[stance] ?? stance;
}

/** The chip tone for a verdict, so every surface colours the same word the same way. */
export function verdictTone(verdict: string): "ok" | "warn" | "down" | "unknown" {
  return verdict === "allow" ? "ok" : verdict === "ask" ? "warn" : verdict === "refuse" ? "down" : "unknown";
}

export const ALL_WORDS = [...Object.values(OP_WORDS), ...Object.values(RISK_WORDS), ...Object.values(VERDICT_WORDS), ...Object.values(STANCE_WORDS)];

const RULE_WORDS: Record<string, string> = {
  "policy-may": "you allowed it",
  "policy-ask": "you asked to be asked",
  "policy-never": "you forbade it",
  "not-granted": "you never granted it",
  "action-cap": "the cap on actions was reached",
  cooldown: "still cooling down from the last act",
  "forbidden-always": "never, for anyone",
  "unknown-operation": "not an action Warden has",
};

/** "policy-may" → "you allowed it" — the rule that decided, in the owner's terms. */
export function ruleWord(rule: string): string {
  return RULE_WORDS[rule] ?? rule.replace(/-/g, " ");
}
