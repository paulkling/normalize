import { ApiError } from "../core/errors.js";

export interface CompletionInput {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface InferenceClient {
  /** Token count for `text`, or null when the tokenizer endpoint is unavailable. */
  tokenize(text: string): Promise<number | null>;
  complete(input: CompletionInput): Promise<CompletionResult>;
  healthy(): Promise<boolean>;
}

/** Strips any reasoning block the chat template might still emit. */
export function cleanModelOutput(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export class HttpLlamaClient implements InferenceClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async tokenize(text: string): Promise<number | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/tokenize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { tokens?: unknown[] };
      return Array.isArray(body.tokens) ? body.tokens.length : null;
    } catch {
      return null;
    }
  }

  async complete(input: CompletionInput): Promise<CompletionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
          temperature: 0,
          top_k: 1,
          max_tokens: input.maxTokens,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ApiError("timeout", undefined, { retry_after_seconds: 5 });
      throw new ApiError("unavailable", undefined, { retry_after_seconds: 10 });
    }
    clearTimeout(timer);
    if (res.status === 503) throw new ApiError("unavailable", undefined, { retry_after_seconds: 10 });
    if (!res.ok) throw new ApiError("inference_failed");
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new ApiError("inference_failed");
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ApiError("inference_failed");
    return {
      text: cleanModelOutput(content),
      inputTokens: typeof body?.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null,
      outputTokens: typeof body?.usage?.completion_tokens === "number" ? body.usage.completion_tokens : null,
    };
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Test double. `handler` decides the output; set `failWith` to simulate model errors. */
export class FakeInferenceClient implements InferenceClient {
  calls: CompletionInput[] = [];
  failWith: ApiError | null = null;
  tokensPerCall: number | null = 40;
  isHealthy = true;
  constructor(private readonly handler: (user: string) => string = (u) => u.split("\n").slice(1).join("\n").trim()) {}
  async tokenize(text: string) {
    return this.tokensPerCall === null ? null : this.tokensPerCall;
  }
  async complete(input: CompletionInput): Promise<CompletionResult> {
    this.calls.push(input);
    if (this.failWith) throw this.failWith;
    const text = this.handler(input.user);
    return { text, inputTokens: this.tokensPerCall, outputTokens: Math.ceil(text.length / 3) };
  }
  async healthy() {
    return this.isHealthy;
  }
}
