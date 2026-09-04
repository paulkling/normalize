import { ApiError, errorBody } from "../core/errors.js";
import { newLogId } from "../core/ids.js";
import { hmacIp } from "../core/keys.js";
import { SYSTEM_PROMPT, buildUserMessage, computeMaxTokens, estimateTokens } from "../core/prompt.js";
import type { Deps } from "../deps.js";
import type { ApiKey, InferenceLog } from "../repos/types.js";
import { MODEL_NAME, normalizeRequestSchema, type NormalizeRequest, type NormalizeResponse } from "../schema/normalize.js";

export interface NormalizeInput {
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  /** Parsed JSON body, or the symbol `INVALID_JSON` when parsing failed. */
  body: unknown;
  ip: string | null;
  userAgent: string | null;
}

export const INVALID_JSON = Symbol("invalid_json");

export interface NormalizeOutcome {
  status: number;
  body: NormalizeResponse | ReturnType<typeof errorBody>;
  headers?: Record<string, string>;
}

export class NormalizeService {
  constructor(private readonly deps: Deps) {}

  async handle(input: NormalizeInput): Promise<NormalizeOutcome> {
    const { deps } = this;
    const startedAt = deps.clock();
    const log: InferenceLog = {
      id: newLogId(),
      key_id: null,
      key_prefix: null,
      user_id: null,
      session_id: null,
      app: null,
      styling: null,
      structure: null,
      context: null,
      transcript: null,
      output: null,
      input_chars: null,
      output_chars: null,
      input_tokens: null,
      output_tokens: null,
      latency_ms: null,
      model_revision: deps.config.modelRevision,
      status: 500,
      error_code: null,
      ip_hmac: input.ip ? hmacIp(input.ip, deps.config.ipHmacSecret) : null,
      user_agent: input.userAgent?.slice(0, 512) ?? null,
      created_at: startedAt.toISOString(),
    };

    let key: ApiKey | null = null;
    let reservedPeriod: string | null = null;
    try {
      key = await deps.keyAuth.resolve(input.authorization);
      log.key_id = key.id;
      log.key_prefix = key.prefix;
      if (key.revoked_at) throw new ApiError("forbidden");

      if (input.idempotencyKey !== undefined) {
        throw new ApiError("invalid_request", "Idempotency-Key is not supported in v1.");
      }
      const settings = await deps.repos.settings.get();
      const req = this.parseBody(input.body, settings.max_transcript_chars, log);

      const limits = await deps.quota.limitsFor(key);
      deps.quota.checkRps(key.id, limits.rps);
      const reservation = await deps.quota.reserve(key, limits.monthly);
      reservedPeriod = reservation.period;

      const userMessage = buildUserMessage(req, req.transcript);
      const tokenized = await deps.inference.tokenize(userMessage);
      if (tokenized !== null && deps.config.maxInputTokens !== null && tokenized > deps.config.maxInputTokens) {
        throw new ApiError("payload_too_large", `Transcript exceeds ${deps.config.maxInputTokens} tokens.`);
      }
      const inputTokens = tokenized ?? estimateTokens(userMessage);
      const result = await deps.inference.complete({
        system: SYSTEM_PROMPT,
        user: userMessage,
        maxTokens: computeMaxTokens(inputTokens),
        timeoutMs: deps.config.inferenceTimeoutMs,
      });

      const latency = deps.clock().getTime() - startedAt.getTime();
      log.status = 200;
      log.output = result.text;
      log.output_chars = result.text.length;
      log.input_tokens = result.inputTokens ?? tokenized;
      log.output_tokens = result.outputTokens;
      log.latency_ms = latency;
      reservedPeriod = null; // success: keep the debit
      await deps.repos.apiKeys.touchLastUsed(key.id, log.created_at);

      const body: NormalizeResponse = {
        id: log.id,
        text: result.text,
        usage: { input_chars: req.transcript.length, output_chars: result.text.length, latency_ms: latency },
        model: MODEL_NAME,
        model_revision: deps.config.modelRevision,
        quota: { key: { remaining: reservation.remaining, reset_at: reservation.reset_at } },
      };
      return { status: 200, body };
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError("inference_failed");
      if (!(err instanceof ApiError)) deps.logger.error("normalize failed", { request_id: log.id, error: String(err) });
      if (key && reservedPeriod) await deps.quota.release(key, reservedPeriod).catch(() => {});
      log.status = apiErr.status;
      log.error_code = apiErr.code;
      log.latency_ms = deps.clock().getTime() - startedAt.getTime();
      const headers: Record<string, string> = {};
      if (apiErr.extras.retry_after_seconds !== undefined) headers["retry-after"] = String(apiErr.extras.retry_after_seconds);
      return { status: apiErr.status, body: errorBody(apiErr), headers };
    } finally {
      await deps.repos.logs.insert(log).catch((e) => deps.logger.error("log insert failed", { request_id: log.id, error: String(e) }));
    }
  }

  private parseBody(body: unknown, maxChars: number, log: InferenceLog): NormalizeRequest {
    if (body === INVALID_JSON) throw new ApiError("invalid_request", "Body must be valid JSON.");
    if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("invalid_request", "Body must be a JSON object.");
    }
    const parsed = normalizeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError("invalid_request", "Request body failed validation.", {
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const req = { ...parsed.data, transcript: parsed.data.transcript.trim() };
    log.styling = req.styling;
    log.structure = req.structure;
    log.context = req.context;
    log.user_id = req.metadata?.user_id ?? null;
    log.session_id = req.metadata?.session_id ?? null;
    log.app = req.metadata?.app ?? null;
    if (req.transcript.length === 0) throw new ApiError("invalid_request", "transcript must not be empty.");
    if (req.transcript.length > maxChars) {
      throw new ApiError("payload_too_large", `transcript must be at most ${maxChars} characters.`);
    }
    log.transcript = req.transcript;
    log.input_chars = req.transcript.length;
    return req;
  }
}
