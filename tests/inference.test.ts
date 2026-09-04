import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createFakeLlama } from "../scripts/fake-llama-server.js";
import { HttpLlamaClient, cleanModelOutput } from "../src/services/inference.js";
import { ApiError } from "../src/core/errors.js";
import { SYSTEM_PROMPT } from "../src/core/prompt.js";

let server: Server | null = null;
async function start(opts = {}) {
  server = createFakeLlama(opts);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  return new HttpLlamaClient(`http://127.0.0.1:${port}`);
}
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

describe("HttpLlamaClient", () => {
  it("tokenizes and completes", async () => {
    const c = await start();
    expect(await c.tokenize("one two three")).toBe(3);
    const r = await c.complete({ system: SYSTEM_PROMPT, user: "[Styling: casual] [Structure: prose] [Context: general]\num hello there", maxTokens: 50, timeoutMs: 1000 });
    expect(r.text).toBe("Hello there.");
    expect(r.outputTokens).toBeGreaterThan(0);
    expect(await c.healthy()).toBe(true);
  });
  it("returns null tokens when tokenizer is broken", async () => {
    const c = await start({ tokenizeBroken: true });
    expect(await c.tokenize("x y")).toBeNull();
  });
  it("maps timeouts to 504", async () => {
    const c = await start({ delayMs: 500 });
    await expect(c.complete({ system: "", user: "\nx", maxTokens: 5, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout", status: 504 });
  });
  it("maps loading model to 503", async () => {
    const c = await start({ loading: true });
    await expect(c.complete({ system: "", user: "\nx", maxTokens: 5, timeoutMs: 500 })).rejects.toMatchObject({ code: "unavailable" });
    expect(await c.healthy()).toBe(false);
  });
  it("maps connection refused to 503 and other errors to 500", async () => {
    const dead = new HttpLlamaClient("http://127.0.0.1:1");
    await expect(dead.complete({ system: "", user: "\nx", maxTokens: 5, timeoutMs: 500 })).rejects.toBeInstanceOf(ApiError);
    await expect(dead.complete({ system: "", user: "\nx", maxTokens: 5, timeoutMs: 500 })).rejects.toMatchObject({ code: "unavailable" });
    const c = await start({ status: 500 });
    await expect(c.complete({ system: "", user: "\nx", maxTokens: 5, timeoutMs: 500 })).rejects.toMatchObject({ code: "inference_failed" });
  });
  it("strips think blocks", () => {
    expect(cleanModelOutput("<think>\nhmm\n</think>\n\nHello.")).toBe("Hello.");
  });
});
