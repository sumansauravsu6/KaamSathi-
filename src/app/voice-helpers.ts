export const PAGES = ["Dashboard", "Voice assistant", "Translator", "Inventory", "Sales", "Customers", "Suppliers", "Customer orders", "Expenses", "Reports"] as const;
export type PageKey = typeof PAGES[number];
export type Speaker = "shopkeeper" | "customer";

export function voiceTurnReady(elapsedMs: number, silenceMs: number | null): boolean {
  return elapsedMs >= 30000 || (silenceMs !== null && silenceMs >= 3000);
}

export function nextSpeaker(speaker: Speaker): Speaker {
  return speaker === "customer" ? "shopkeeper" : "customer";
}

export interface PlayableMedia extends EventTarget {
  readonly ended: boolean;
  play(): Promise<void>;
  pause(): void;
}
export type PlaybackResult = { ok: true } | { ok: false; reason: "aborted" | "paused" | "error" | "blocked" };

// Browsers fire "pause" just before "ended" when media finishes naturally, so pause only stops when not ended.
export function waitForPlayback(media: PlayableMedia, signal?: AbortSignal): Promise<PlaybackResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PlaybackResult) => {
      if (settled) return;
      settled = true;
      media.removeEventListener("ended", ended);
      media.removeEventListener("error", failed);
      media.removeEventListener("pause", paused);
      signal?.removeEventListener("abort", aborted);
      resolve(result);
    };
    const ended = () => finish({ ok: true });
    const failed = () => finish({ ok: false, reason: "error" });
    const paused = () => { if (!media.ended) finish({ ok: false, reason: "paused" }); };
    const aborted = () => { finish({ ok: false, reason: "aborted" }); media.pause(); };
    media.addEventListener("ended", ended);
    media.addEventListener("error", failed);
    media.addEventListener("pause", paused);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    media.play().catch(() => finish({ ok: false, reason: "blocked" }));
  });
}

export function playbackStopReason(result: PlaybackResult): string {
  if (result.ok || result.reason === "aborted") return "";
  if (result.reason === "blocked") return "Automatic playback was blocked. Use the audio controls, then start the conversation again.";
  if (result.reason === "error") return "Speech playback failed. Use the audio controls or type, then start again.";
  return "Playback was paused, so listening stopped. Start the conversation again when ready.";
}

export function pageDestination(value: unknown): PageKey | null {
  return typeof value === "string" && PAGES.some((page) => page === value) ? value as PageKey : null;
}

export function workflowAction(destination: PageKey | null, value: unknown): "add_supplier" | null {
  return destination === "Suppliers" && value === "add_supplier" ? "add_supplier" : null;
}

export function assistantSpeech(text: string, pending: { summary: string } | null, confirmationPrompt: boolean | undefined): string {
  return confirmationPrompt && pending ? `${pending.summary} ${text}` : text;
}

export function supportedLanguage(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const normalized = code.toLowerCase().replace("_", "-");
  if (normalized === "hi" || normalized === "hi-in") return "hi-IN";
  if (normalized === "en" || normalized === "en-in") return "en-IN";
  if (normalized === "ta" || normalized === "ta-in") return "ta-IN";
  return null;
}

export function customerDetection(code: unknown, probability: unknown): { language: string; probability: number } | null {
  const language = supportedLanguage(code);
  if (!language || typeof probability !== "number" || !Number.isFinite(probability) || probability < 0.65 || probability > 1) return null;
  return { language, probability };
}

export function normalizeSpokenIdentifier(text: string): string {
  const words: Record<string, string> = {
    zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  };
  const tokens = text.trim().toLowerCase().replace(/[,().-]/g, " ").split(/\s+/);
  let result = "";
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === "plus" || token === "+") && !result) { result = "+"; continue; }
    if (token === "double" || token === "triple") {
      const digit = words[tokens[++i]] || (/^\d$/.test(tokens[i] || "") ? tokens[i] : "");
      if (!digit) return text;
      result += digit.repeat(token === "double" ? 2 : 3);
      continue;
    }
    if (words[token]) result += words[token];
    else if (/^\+?\d+$/.test(token) && (!token.startsWith("+") || !result)) result += token;
    else return text;
  }
  const digits = result.startsWith("+") ? result.slice(1) : result;
  return digits.length >= 7 && digits.length <= 15 ? result : text;
}

export function errorDetailMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (!Array.isArray(detail)) return fallback;
  const messages = detail.flatMap((item: unknown) => {
    if (typeof item === "string" && item.trim()) return [item];
    if (!item || typeof item !== "object") return [];
    const { msg, loc } = item as { msg?: unknown; loc?: unknown };
    if (typeof msg !== "string" || !msg.trim()) return [];
    const field = Array.isArray(loc) ? loc.filter((part): part is string => typeof part === "string" && part !== "body").pop() : undefined;
    return [field ? `${field.replace(/_/g, " ")}: ${msg}` : msg];
  });
  return messages.length ? messages.join(" ") : fallback;
}

export function businessAudioAllowed(page: string | null | undefined): boolean {
  return page !== "Translator";
}
