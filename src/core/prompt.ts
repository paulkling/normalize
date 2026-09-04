export type Styling = "casual" | "semi-casual" | "semi-formal" | "formal";
export type Structure = "prose" | "lists";
export type Context = "general" | "email";

export interface Controls {
  styling: Styling;
  structure: Structure;
  context: Context;
}

/** Required by the model. Do not edit. */
export const SYSTEM_PROMPT =
  "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";

export const MAX_NEW_TOKENS_CEILING = 700;

const CONTROL_MARKERS = ["[Styling:", "[Structure:", "[Context:"];

export function buildControlLine(c: Controls): string {
  return `[Styling: ${c.styling}] [Structure: ${c.structure}] [Context: ${c.context}]`;
}

/** A transcript that begins with a control marker gets one leading space so it cannot parse as a control line. */
export function guardTranscript(transcript: string): string {
  return CONTROL_MARKERS.some((m) => transcript.startsWith(m)) ? ` ${transcript}` : transcript;
}

export function buildUserMessage(c: Controls, transcript: string): string {
  return `${buildControlLine(c)}\n${guardTranscript(transcript)}`;
}

export function computeMaxTokens(inputTokens: number): number {
  return Math.min(MAX_NEW_TOKENS_CEILING, Math.ceil(1.3 * inputTokens) + 32);
}

/** Fallback estimate when llama-server's /tokenize is unavailable. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}
