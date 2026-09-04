import { z } from "zod";
import type { AppConfig } from "./deps.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_URL: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  LLAMA_URL: z.url().default("http://127.0.0.1:8080"),
  KEY_PEPPER: z.string().min(16),
  IP_HMAC_SECRET: z.string().min(16),
  SESSION_SECRET: z.string().min(32),
  MODEL_REVISION: z.string().default("q4_k_m-2026-08"),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  MAX_INPUT_TOKENS: z.coerce.number().int().min(1).nullable().default(500),
  MAGIC_LINK_PER_EMAIL_PER_HOUR: z.coerce.number().int().min(1).default(5),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  /** Set to "fake" to use the in-memory identity provider (local development only). */
  IDENTITY_PROVIDER: z.enum(["supabase", "fake"]).default("supabase"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  const env = parsed.data;
  if (env.IDENTITY_PROVIDER === "supabase" && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless IDENTITY_PROVIDER=fake");
  }
  if (env.NODE_ENV === "production" && env.IDENTITY_PROVIDER === "fake") {
    throw new Error("IDENTITY_PROVIDER=fake is not allowed in production");
  }
  return env;
}

export function toAppConfig(env: Env): AppConfig {
  return {
    publicUrl: env.PUBLIC_URL.replace(/\/$/, ""),
    keyPepper: env.KEY_PEPPER,
    ipHmacSecret: env.IP_HMAC_SECRET,
    sessionSecret: env.SESSION_SECRET,
    modelRevision: env.MODEL_REVISION,
    inferenceTimeoutMs: env.INFERENCE_TIMEOUT_MS,
    maxInputTokens: env.MAX_INPUT_TOKENS,
    secureCookies: env.PUBLIC_URL.startsWith("https://"),
    magicLinkPerEmailPerHour: env.MAGIC_LINK_PER_EMAIL_PER_HOUR,
  };
}
