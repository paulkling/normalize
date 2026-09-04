import type { Repos } from "./repos/interfaces.js";
import type { IdentityProvider } from "./services/identity.js";
import type { InferenceClient } from "./services/inference.js";
import type { KeyAuthService } from "./services/keyAuth.js";
import type { QuotaService } from "./services/quota.js";

export interface AppConfig {
  /** Public origin used for magic-link redirects, e.g. https://normalize.example.com */
  publicUrl: string;
  keyPepper: string;
  ipHmacSecret: string;
  sessionSecret: string;
  modelRevision: string;
  inferenceTimeoutMs: number;
  /** Optional token cap enforced when llama-server's /tokenize is reachable. */
  maxInputTokens: number | null;
  secureCookies: boolean;
  magicLinkPerEmailPerHour: number;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface Deps {
  config: AppConfig;
  repos: Repos;
  inference: InferenceClient;
  keyAuth: KeyAuthService;
  quota: QuotaService;
  identity: IdentityProvider;
  logger: Logger;
  clock: () => Date;
}

export const consoleLogger: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ level: "info", msg, ...fields, ts: new Date().toISOString() })),
  warn: (msg, fields) => console.warn(JSON.stringify({ level: "warn", msg, ...fields, ts: new Date().toISOString() })),
  error: (msg, fields) => console.error(JSON.stringify({ level: "error", msg, ...fields, ts: new Date().toISOString() })),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
