/**
 * Minimal stand-in for llama-server used by tests and local development.
 * Implements /health, /tokenize and /v1/chat/completions with a toy normalizer.
 */
import { createServer, type Server } from "node:http";

export interface FakeLlamaOptions {
  delayMs?: number;
  status?: number; // force a status code on chat completions
  loading?: boolean; // /health and completions return 503
  tokenizeBroken?: boolean;
}

const FILLERS = /\b(um+|uh+|erm|like,|you know,)\b\s*/gi;

export function toyNormalize(user: string): string {
  const transcript = user.split("\n").slice(1).join("\n");
  const cleaned = transcript.replace(FILLERS, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const sentence = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function createFakeLlama(opts: FakeLlamaOptions = {}): Server {
  const state = { ...opts };
  const server = createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/health") return json(state.loading ? 503 : 200, { status: state.loading ? "loading model" : "ok" });
      if (req.url === "/tokenize") {
        if (state.tokenizeBroken) return json(500, { error: "broken" });
        const { content } = JSON.parse(raw || "{}");
        const tokens = String(content ?? "").split(/\s+/).filter(Boolean).map((_, i) => i + 1);
        return json(200, { tokens });
      }
      if (req.url === "/v1/chat/completions") {
        const finish = () => {
          if (state.loading) return json(503, { error: { message: "Loading model" } });
          if (state.status && state.status !== 200) return json(state.status, { error: { message: "forced" } });
          const body = JSON.parse(raw || "{}");
          const user = body.messages?.find((m: any) => m.role === "user")?.content ?? "";
          const text = toyNormalize(user);
          return json(200, {
            id: "chatcmpl-fake",
            object: "chat.completion",
            model: "normalize-v1",
            choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
            usage: { prompt_tokens: Math.ceil(user.length / 3), completion_tokens: Math.ceil(text.length / 3) },
          });
        };
        if (state.delayMs) setTimeout(finish, state.delayMs);
        else finish();
        return;
      }
      json(404, { error: "not found" });
    });
  });
  (server as any).state = state;
  return server;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  const port = Number(process.env.FAKE_LLAMA_PORT ?? 8080);
  createFakeLlama().listen(port, "127.0.0.1", () => console.log(`fake llama-server on http://127.0.0.1:${port}`));
}
