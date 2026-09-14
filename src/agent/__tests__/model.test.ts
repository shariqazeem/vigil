import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BedrockModel, ModelRouter } from "@strands-agents/sdk";
import { OpenAIModel } from "@strands-agents/sdk/models/openai";
import { makeModel, modelLabel } from "@/agent/model";

/**
 * WHICH MODEL ACTUALLY RUNS A PASS.
 *
 * Two claims are made about this on the page and in the README, and a reader is entitled to be
 * sceptical of both. The first is that setting one variable moves every agent onto Amazon Bedrock.
 * The second is the more interesting one: the console says which provider ran each pass, and that
 * line has to be the truth rather than the intention — a product that says "Bedrock" while falling
 * back to a gateway is worse than one that never mentioned Bedrock.
 *
 * Nothing here calls a model. Constructing one is enough to prove which one was constructed.
 */
const KEYS = ["BEDROCK_MODEL_ID", "BEDROCK_MODEL_ID_HEAVY", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "WARDEN_MODEL_HEAVY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const gateway = () => {
  process.env.LLM_BASE_URL = "https://api.example.com/v1";
  process.env.LLM_API_KEY = "not-a-real-key";
  process.env.LLM_MODEL = "some-model";
};

describe("with only an OpenAI-compatible gateway, which is what the live instance runs", () => {
  it("builds that and says so", () => {
    gateway();
    const m = makeModel("investigate");
    expect(m.instance).toBeInstanceOf(OpenAIModel);
    expect(m.provider).toBe("openai-compatible");
    expect(modelLabel()).toContain("openai-compatible");
    // and it does not claim Bedrock anywhere
    expect(modelLabel().toLowerCase()).not.toContain("bedrock");
  });

  it("refuses to start rather than guessing when nothing is configured", () => {
    expect(() => makeModel("investigate")).toThrow(/BEDROCK_MODEL_ID|LLM_BASE_URL/);
  });
});

describe("with Bedrock configured", () => {
  it("puts Bedrock in front, with the gateway behind it as a fallback", () => {
    gateway();
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";
    const m = makeModel("investigate");
    // A ModelRouter, because a watch that runs for years cannot go dark when one provider does.
    expect(m.instance).toBeInstanceOf(ModelRouter);
    expect(m.provider).toBe("bedrock+gateway");
    expect(m.id).toContain("claude-sonnet-4");
    expect(m.id).toContain("some-model");
  });

  it("runs on Bedrock alone when there is no gateway to fall back to", () => {
    process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
    const m = makeModel("remedy");
    expect(m.instance).toBeInstanceOf(BedrockModel);
    expect(m.provider).toBe("bedrock");
    expect(m.id).toBe("us.amazon.nova-pro-v1:0");
  });

  it("gives the two judgement roles the stronger model when one is named", () => {
    process.env.BEDROCK_MODEL_ID = "us.amazon.nova-lite-v1:0";
    process.env.BEDROCK_MODEL_ID_HEAVY = "us.anthropic.claude-sonnet-4-20250514-v1:0";
    // Reading a stack trace against a diff, and deciding what to do about a production system, are
    // judgement. Summarising afterwards is not.
    expect(makeModel("investigate").id).toContain("claude-sonnet-4");
    expect(makeModel("remedy").id).toContain("claude-sonnet-4");
    expect(makeModel("brief").id).toContain("nova-lite");
  });

  it("takes a Bedrock API key as well as the standard credential chain", () => {
    process.env.BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "not-a-real-token";
    expect(makeModel("brief").instance).toBeInstanceOf(BedrockModel);
  });
});
