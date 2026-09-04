import { z } from "zod";

export const STYLINGS = ["casual", "semi-casual", "semi-formal", "formal"] as const;
export const STRUCTURES = ["prose", "lists"] as const;
export const CONTEXTS = ["general", "email"] as const;
export const MODEL_NAME = "normalize-v1";

const metadataField = z.string().max(128);

export const metadataSchema = z
  .strictObject({
    user_id: metadataField.optional(),
    session_id: metadataField.optional(),
    app: metadataField.optional(),
  })
  .describe("Optional caller metadata stored on the log row.");

/** Character cap is validated separately (413) so that it can be a runtime setting. */
export const normalizeRequestSchema = z
  .strictObject({
    transcript: z.string().describe("Raw ASR text, 1–2,000 characters after trimming."),
    styling: z.enum(STYLINGS).default("semi-formal"),
    structure: z.enum(STRUCTURES).default("prose"),
    context: z.enum(CONTEXTS).default("general"),
    metadata: metadataSchema.optional(),
  })
  .describe("POST /v1/normalize request body.");

export type NormalizeRequest = z.infer<typeof normalizeRequestSchema>;

const quotaWindowSchema = z.strictObject({
  remaining: z.int().nonnegative(),
  reset_at: z.iso.datetime(),
});

export const normalizeResponseSchema = z
  .strictObject({
    id: z.string(),
    text: z.string(),
    usage: z.strictObject({
      input_chars: z.int().nonnegative(),
      output_chars: z.int().nonnegative(),
      latency_ms: z.int().nonnegative(),
    }),
    model: z.literal(MODEL_NAME),
    model_revision: z.string(),
    quota: z.strictObject({
      key: quotaWindowSchema,
      user: quotaWindowSchema.optional(),
    }),
  })
  .describe("POST /v1/normalize success response.");

export type NormalizeResponse = z.infer<typeof normalizeResponseSchema>;

export const errorResponseSchema = z
  .strictObject({
    error: z.strictObject({
      code: z.enum([
        "invalid_request",
        "unauthorized",
        "forbidden",
        "payload_too_large",
        "quota_exceeded",
        "rate_limited",
        "inference_failed",
        "unavailable",
        "timeout",
      ]),
      message: z.string(),
      reset_at: z.iso.datetime().optional(),
      retry_after_seconds: z.int().nonnegative().optional(),
      details: z.unknown().optional(),
    }),
  })
  .describe("Error response body.");

/** Published at GET /v1/schema. */
export function buildPublishedSchema(maxTranscriptChars: number) {
  const request = z.toJSONSchema(normalizeRequestSchema, { io: "input" }) as Record<string, unknown>;
  const props = request.properties as Record<string, Record<string, unknown>>;
  props.transcript = { ...props.transcript, minLength: 1, maxLength: maxTranscriptChars };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://normalize.internal/v1/schema",
    title: "Normalize API v1",
    model: MODEL_NAME,
    endpoint: { method: "POST", path: "/v1/normalize", auth: "Authorization: Bearer nrm_..." },
    request,
    response: z.toJSONSchema(normalizeResponseSchema),
    error: z.toJSONSchema(errorResponseSchema),
  };
}
