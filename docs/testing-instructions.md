# Testing instructions

Nothing to install, no account, no API key. The live console is public on purpose.

## 1. Watch it work on a real outage (90 seconds)

Go to **https://getwarden.vercel.app/fleet**. Three real services are on the board, all on one VM.

If the board is green, press **Break Vigil on purpose**, then **Do it**. That really runs
`pm2 stop vigil` on the actual machine — Vigil is a public site and it goes down. Warden's own
check notices, a problem opens, and you land on its page with the run already streaming:

- what it looked at, and why it looked there
- the cause it commits to, with how sure it is
- your rule, and which rule decided
- the act
- **the same check that failed, run again**

The incident closes only on a clean reading, and the reading's id is stored on the incident as the
proof. Scroll to **Everything it ran**: every action with the exact command, the rule that permitted
it, and the time it took. Copy any command and run it yourself.

One timing note: the rules on that service allow one act every three minutes. If you press the
button twice inside that window, the second run stops and asks you instead of fixing — which is the
other half of the product, and worth seeing once.

## 2. Point it at something of yours (60 seconds)

Press **Watch something of yours**, or go to `/new`.

- **URL to check** — anything you run that is up right now.
- **Deploy or restart hook** *(optional, but this is the interesting part)* — the URL Render,
  Railway, Vercel, Fly or Coolify gives you to redeploy the app when POSTed. With it, Warden can
  bring a service back that it cannot otherwise reach. The key in it is redacted from every command
  and every log.
- **A webhook** *(optional)* — a Slack or Discord incoming webhook, so you hear when something
  breaks and when Warden stops to ask.
- **What Warden may do** — start on *Ask me first* if you want to approve each act.

That is the whole sign-up: a signed cookie makes the service yours. The next round picks it up.
`/start` issues a recovery key so a cleared browser is not the end of your fleet. You can delete a
service from the bottom of its own page.

To see the URL-only path work end to end without waiting for a real outage, point it at a URL that
is already failing and press **Check it now**, then **Hand it to Warden** on the problem that opens.

## 3. Prove the boundaries on your own machine (one command, offline)

No network, no model, no API key, nothing spawned:

```bash
git clone https://github.com/shariqazeem/warden && cd warden
npm install --legacy-peer-deps
npx vitest run
# 20 files, 327 tests, ~1s
```

The two claims worth checking directly:

```bash
# the red team: a jailbroken sequence pushed through the real hooks and the real tools
npx vitest run src/agent/__tests__/gates.test.ts

# the rules are a pure function — no clock, no model, no network — so every branch is proven by hand
npx vitest run src/lib/ops/policy.test.ts
```

## 4. Run the operator yourself

`.env` needs one model endpoint. Either an OpenAI-compatible one (`LLM_BASE_URL`, `LLM_API_KEY`,
`LLM_MODEL`) or Amazon Bedrock (`BEDROCK_MODEL_ID` plus AWS credentials and `AWS_REGION`), which
switches every agent over through a Strands `ModelRouter`.

```bash
npx tsx --env-file=.env scripts/warden.ts register        # register a fleet
npx tsx --env-file=.env scripts/warden.ts sweep           # ask every check once
npx tsx --env-file=.env scripts/warden.ts handle <id>     # work one problem, streaming
npx tsx --env-file=.env scripts/warden.ts answer <id> approve
npm run dev -- -p 3200                                    # the console, same functions behind it
```

## What to look at in the code, in this order

1. `src/lib/ops/policy.ts` — about 150 lines, one pure function. Note the order of the branches:
   unknown first, forbidden before the rules are consulted at all, `never` beating `may`, caps last.
2. `src/lib/ops/operations.ts` — the whole catalogue. Twenty named actions, zod-validated, spawned
   with `execFile`. There is no shell. Four are declared *forbidden* rather than omitted, so the
   product can show you the line.
3. `src/agent/warden.ts` — the Strands `Graph`, the conditional edge that refuses to reach the
   acting agent without a diagnosis at 0.5 confidence, and `settle()`, which is the only place a
   verdict is issued.
4. `src/agent/guards.ts` — the four rules no policy can switch off, as `BeforeToolCallEvent` hooks.

## Known limits, so you are not surprised

- The deployed instance runs MiniMax-M3 through an OpenAI-compatible gateway, not Bedrock. Bedrock
  is wired as the primary of a `ModelRouter` with a fallback behind it and switches on with one
  environment variable. The console prints which model actually ran.
- The public instance has no ssh keys configured, so a service you register there is watched over
  the network: it can be diagnosed (does the name resolve, what answers, is it a proxy's error page,
  is the certificate near expiry) and brought back by its deploy hook, but nothing on your machine
  is touched.
- SAGE, the third service on the board, is someone else's production and is registered *observe
  only*: every read allowed, every act refused by name, action cap zero. That card is the product in
  one screen.
