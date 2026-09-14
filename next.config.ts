import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The VM builds in a sibling directory whose node_modules is a symlink into the live app; Turbopack
   * refuses a symlink that leaves the project root unless the root is widened to cover both.
   */
  ...(process.env.VIGIL_TURBO_ROOT ? { turbopack: { root: process.env.VIGIL_TURBO_ROOT } } : {}),
  /**
   * Loaded from node_modules at runtime, never bundled: the Strands SDK carries optional imports for
   * every provider it supports (S3 offloading, Bedrock, MCP over stdio) and a bundler tries to resolve
   * all of them; better-sqlite3 is native; the OpenAI client ships its own conditional exports.
   */
  serverExternalPackages: [
    "@strands-agents/sdk",
    "openai",
    "better-sqlite3",
    "@modelcontextprotocol/sdk",
    "@a2a-js/sdk",
    "express",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/sdk-metrics",
    "@opentelemetry/resources",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/exporter-metrics-otlp-http",
  ],
};

export default nextConfig;
