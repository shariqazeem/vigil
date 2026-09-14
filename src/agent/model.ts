import { BedrockModel, DefaultModelRetryStrategy, ExponentialBackoff, FallbackStrategy, ModelRouter, RoutingCandidate } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";

/**
 * One place that decides which model each part of Warden runs on. Nothing else constructs a model.
 *
 * On AWS the agents run on Amazon Bedrock: set BEDROCK_MODEL_ID (plus AWS credentials / AWS_REGION,
 * or AWS_BEARER_TOKEN_BEDROCK) and every role switches — and because a watch that runs for years
 * cannot go dark when one provider does, Bedrock is wired as the PRIMARY of a Strands ModelRouter
 * with the OpenAI-compatible gateway behind it as a FallbackStrategy. With no Bedrock configured
 * the gateway is used on its own, and the product says so honestly rather than pretending.
 *
 * Roles exist because the work is not all the same difficulty. Reading a stack trace against last
 * night's diff, and deciding what to do about a system that is down right now, are judgement.
 * Writing the summary afterwards is not. `WARDEN_MODEL_HEAVY` may name a stronger model for the
 * judgement roles; without it every role shares one model and nothing breaks.
 */
export type Role = "investigate" | "remedy" | "brief";

const HEAVY: Role[] = ["investigate", "remedy"];
/**
 * Reading a stack trace against a diff and deciding what to do about a production system at 3am is
 * judgement, and gets the better model. Summarising afterwards is not.
 */
const DEFAULT_MODEL = "MiniMax-M3";
/**
 * Kept under the gateway's per-request cost ceiling. Commonstack reserves `max_tokens × price`
 * against the key's cap before it will start a request, and rejects the whole call with
 * `429 quota exceeded (cap 0.5)` if the reservation does not fit — measured: 4000 passes, 8000 does
 * not. Nothing Warden writes is long — a diagnosis is a paragraph — so the ceiling costs it nothing,
 * and a 429 costs it a whole pass.
 */
const MAX_TOKENS = Number(process.env.WARDEN_MAX_TOKENS ?? 3000);

export interface MadeModel {
  instance: OpenAIModel | BedrockModel | ModelRouter;
  id: string;
  provider: "bedrock" | "bedrock+gateway" | "openai-compatible";
}

function gateway(modelId: string): OpenAIModel {
  const baseURL = process.env.LLM_BASE_URL ?? process.env.COMMONSTACK_BASE_URL;
  const apiKey = process.env.LLM_API_KEY ?? process.env.COMMONSTACK_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("No model configured: set BEDROCK_MODEL_ID for Bedrock, or LLM_BASE_URL and LLM_API_KEY for an OpenAI-compatible endpoint.");
  }
  return new OpenAIModel({ api: "chat", modelId, apiKey, clientConfig: { baseURL }, maxTokens: MAX_TOKENS });
}

/**
 * Backoff that survives a provider having a bad minute. A nightly watch retries; it does not fail.
 * One instance per agent — the SDK binds a strategy to the agent that owns it.
 */
export const retryStrategy = (): DefaultModelRetryStrategy =>
  new DefaultModelRetryStrategy({
    maxAttempts: 4,
    backoff: new ExponentialBackoff({ baseMs: 500, maxMs: 20_000, jitter: "decorrelated" }),
  });

export function makeModel(role: Role = "investigate"): MadeModel {
  const heavy = HEAVY.includes(role);
  const gatewayId = (heavy ? process.env.WARDEN_MODEL_HEAVY : undefined) ?? process.env.LLM_MODEL ?? DEFAULT_MODEL;
  const bedrockId = (heavy ? process.env.BEDROCK_MODEL_ID_HEAVY : undefined) ?? process.env.BEDROCK_MODEL_ID?.trim();

  if (!bedrockId) return { instance: gateway(gatewayId), id: gatewayId, provider: "openai-compatible" };

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-west-2";
  const bedrock = new BedrockModel({
    modelId: bedrockId,
    region,
    maxTokens: MAX_TOKENS,
    // Bedrock prompt caching: the system prompts here are long and identical across a pass.
    cacheConfig: { strategy: "auto" },
    ...(process.env.AWS_BEARER_TOKEN_BEDROCK ? { apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK } : {}),
  });

  // If a gateway is also configured, Bedrock leads and the gateway catches.
  try {
    const fallback = gateway(gatewayId);
    const router = new ModelRouter(
      [
        new RoutingCandidate({ model: bedrock, name: "bedrock", description: `Amazon Bedrock ${bedrockId}` }),
        new RoutingCandidate({ model: fallback, name: "gateway", description: `fallback ${gatewayId}` }),
      ],
      { strategy: new FallbackStrategy(), maxSwitches: 2 },
    );
    return { instance: router, id: `${bedrockId} → ${gatewayId}`, provider: "bedrock+gateway" };
  } catch {
    return { instance: bedrock, id: bedrockId, provider: "bedrock" };
  }
}

/** What the product tells the truth about on screen: which model actually ran this pass. */
export function modelLabel(): string {
  const m = makeModel("investigate");
  return `${m.id} (${m.provider})`;
}
