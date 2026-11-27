"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceSession } from "../../use-voice-session";
import { playbackStopReason, waitForPlayback } from "../../voice-helpers";
import { AssistantResult, body, Language, money, Order, Product, request, Shop, ShoppingError, statusLabel } from "./shopping-api";

type Preferences = { readAloud: boolean; contrast: boolean; large: boolean; simple: boolean; textOnly: boolean; guided: boolean };
type ConversationLine = { id: string; speaker: string; text: string };
type Step = "products" | "cart" | "assistant" | "messages";
const steps: { id: Step; label: string; heading: string }[] = [
  { id: "products", label: "Browse", heading: "products-heading" },
  { id: "cart", label: "Cart & order", heading: "cart-heading" },
  { id: "assistant", label: "Assistant", heading: "assistant-heading" },
  { id: "messages", label: "Messages", heading: "messages-heading" },
];
const initialPreferences: Preferences = { readAloud: false, contrast: false, large: false, simple: false, textOnly: false, guided: false };
const phrases = ["Is this available?", "Please help me find an item.", "Please communicate with me in writing.", "Please bring my order to the counter and reply here.", "When can I collect my order?", "Thank you."];
const instructions = "Choose products and save your cart. Review the current items and total, then confirm only if you want to place the order. The shopkeeper will respond. No payment is taken here.";
const terminal = ["rejected", "completed", "cancelled"];

function uniqueId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cartSummary(order: Order, language: Language): string {
  const items = order.items.map((item) => `${item.name}, ${item.quantity} ${item.unit}, ${money(item.line_total)}`).join(". ");
  if (language === "hi-IN") return `ऑर्डर की समीक्षा। ${items || "आपकी टोकरी खाली है।"} कुल ${money(order.total)}। ऑर्डर देना चाहते हैं तो ही पुष्टि करें।`;
  if (language === "ta-IN") return `ஆர்டர் விவரங்கள். ${items || "உங்கள் கூடை காலியாக உள்ளது."} மொத்தம் ${money(order.total)}. ஆர்டர் செய்ய விரும்பினால் மட்டுமே உறுதிப்படுத்துங்கள்.`;
  return `Order review. ${items || "Your cart is empty."} Total ${money(order.total)}. Confirm only if you want to place this order.`;
}

function ProductIcon({ category }: { category: string }) {
  const categoryName = (category || "").toLowerCase();
  return <svg aria-hidden="true" viewBox="0 0 64 64" fill="none" className="shopping-product-icon">
    {categoryName.match(/fruit|vegetable|produce/) ? <><path d="M32 23c-7-8-20-4-20 8 0 12 10 23 20 23s20-11 20-23c0-12-13-16-20-8Z" fill="#b9d1a5" /><path d="M32 24c0-9 5-14 12-15M33 17c-5-7-11-7-14-6" stroke="#315c3a" strokeWidth="3" strokeLinecap="round" /></> :
      categoryName.match(/milk|dairy|drink|beverage/) ? <><path d="M24 10h16v10l6 9v22H18V29l6-9z" fill="#c5dac9" stroke="#315c3a" strokeWidth="2" /><path d="M19 36h26" stroke="#315c3a" strokeWidth="2" /></> :
        <><path d="M18 15h28l4 38H14z" fill="#e5cda4" stroke="#755a36" strokeWidth="2" /><path d="M18 23h28M22 40h20" stroke="#755a36" strokeWidth="2" /></>}
  </svg>;
}

export default function ShoppingApp({ shopId, embedded = false, onChooseShop, onMerchant }: {
  shopId: string; embedded?: boolean; onChooseShop?: () => void; onMerchant?: () => void;
}) {
  const storageKey = `kaamsaathi-shopping:${shopId}`;
  const [shop, setShop] = useState<Shop | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const orderRef = useRef<Order | null>(null);
  const tokenRef = useRef("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const quantityBaseRef = useRef<number | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [notes, setNotes] = useState("");
  const [detailsDirty, setDetailsDirty] = useState(false);
  const detailsDirtyRef = useRef(false);
  const detailsBaseRef = useRef<number | null>(null);
  const [editConflict, setEditConflict] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({ ...initialPreferences, simple: embedded, guided: embedded });
  const [language, setLanguage] = useState<Language>("en-IN");
  const [search, setSearch] = useState("");
  const [productIndex, setProductIndex] = useState(0);
  const [status, setStatus] = useState("Loading shop…");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [pollProblem, setPollProblem] = useState("");
  const [catalogueProblem, setCatalogueProblem] = useState("");
  const [orderUpdate, setOrderUpdate] = useState("");
  const [step, setStep] = useState<Step>("products");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [reviewBlocked, setReviewBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [conversation, setConversation] = useState<ConversationLine[]>([]);
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  const manualGenerationRef = useRef(0);
  const manualMicRef = useRef(false);
  const continuousMicRef = useRef(false);
  const mountedRef = useRef(false);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const notificationRef = useRef<(text: string) => void>(() => {});
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef("");
  const playbackGeneration = useRef(0);
  const [focusTarget, setFocusTarget] = useState<{ headingId: string } | null>(null);
  const pollGeneration = useRef(0);

  useEffect(() => {
    if (focusTarget) document.getElementById(focusTarget.headingId)?.focus();
  }, [focusTarget]);

  useEffect(() => {
    if (embedded) document.getElementById("shopping-main")?.focus();
  }, [embedded]);

  const applyOrder = useCallback((next: Order, syncEdits = false) => {
    const previous = orderRef.current;
    if (previous && previous.id === next.id && next.revision < previous.revision) return;
    orderRef.current = next;
    setOrder(next);
    if (!previous && next.status !== "draft") setStep("cart");
    if (syncEdits || !dirtyRef.current) {
      setQuantities(Object.fromEntries(next.items.map((item) => [item.product_id, item.quantity])));
      if (syncEdits) { dirtyRef.current = false; setDirty(false); }
    }
    if (syncEdits || !detailsDirtyRef.current) {
      setCustomerName(next.customer_name || "");
      setNotes(next.notes || "");
      if (syncEdits) { detailsDirtyRef.current = false; setDetailsDirty(false); }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    try {
      const saved = localStorage.getItem("kaamsaathi-shopping-preferences");
      if (saved) {
        const restored = { ...initialPreferences, simple: embedded, guided: embedded, ...JSON.parse(saved) };
        if (restored.textOnly) restored.readAloud = false;
        setPreferences(restored);
      }
      tokenRef.current = localStorage.getItem(storageKey) || "";
    } catch { setStatus("Device storage is unavailable. Your order access may not be saved after closing this page."); }
    if (!embedded && "serviceWorker" in navigator) void navigator.serviceWorker.register("/shopping-sw.js", { scope: "/shop/" }).catch(() => {
      if (alive) setStatus("Offline help could not be installed. Online shopping still works while connected.");
    });
    void (async () => {
      try {
        const data = await request<Shop>(shopId, "");
        if (!alive) return;
        setShop(data);
        setStatus("Shop loaded. Browse products or ask the assistant.");
        if (tokenRef.current) {
          const savedToken = tokenRef.current;
          try {
            const cart = await request<Order>(shopId, "/cart", savedToken);
            if (alive && tokenRef.current === savedToken) { applyOrder(cart); setStatus(`Saved order loaded. Status: ${statusLabel(cart.status)}.`); }
          } catch (error) {
            if (alive && tokenRef.current === savedToken && error instanceof ShoppingError && error.status === 401) setSessionExpired(true);
            else if (alive && tokenRef.current === savedToken) setStatus("Could not load your saved order. Check your connection or ask the shop for help. Your saved access has not been removed.");
          }
        }
      } catch (error) {
        if (alive) setStatus(error instanceof Error ? error.message : "Could not load the shop.");
      }
    })();
    return () => { alive = false; };
  }, [shopId, storageKey, applyOrder, embedded]);

  useEffect(() => {
    if (!order || !tokenRef.current || sessionExpired) return;
    let stopped = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || busyRef.current || pending) return;
      const generation = pollGeneration.current;
      pending = true;
      void request<Order>(shopId, `/orders/${encodeURIComponent(order.id)}`, tokenRef.current).then((next) => {
        if (stopped || busyRef.current || generation !== pollGeneration.current || orderRef.current?.id !== next.id) return;
        setPollProblem("");
        const previous = orderRef.current;
        if (previous && next.revision < previous.revision) return;
        if (previous && (previous.status !== next.status || JSON.stringify(previous.proposal) !== JSON.stringify(next.proposal) || previous.messages.length !== next.messages.length)) {
          const knownMessages = new Set(previous.messages.map((item) => item.id));
          const merchantMessages = next.messages.filter((item) => item.sender === "shopkeeper" && !knownMessages.has(item.id));
          const text = `Order update: ${statusLabel(next.status)}.${next.proposal && JSON.stringify(previous.proposal) !== JSON.stringify(next.proposal) ? " A substitution needs your decision." : ""}${merchantMessages.map((item) => ` Shopkeeper says: ${item.text}`).join("")}${previous.messages.length !== next.messages.length && !merchantMessages.length ? " Messages updated." : ""}`;
          setOrderUpdate(text);
          notificationRef.current(text);
        }
        applyOrder(next);
      }).catch((error: unknown) => {
        if (stopped || busyRef.current || generation !== pollGeneration.current) return;
        if (error instanceof ShoppingError && error.status === 401) setSessionExpired(true);
        else setPollProblem("Order updates are unavailable. Check your connection; the displayed status and messages may be out of date.");
      }).finally(() => { pending = false; });
    }, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [order?.id, shopId, applyOrder, sessionExpired]);

  useEffect(() => {
    let stopped = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || pending) return;
      pending = true;
      void request<Shop>(shopId, "").then((data) => {
        if (!stopped) { setShop(data); setCatalogueProblem(""); }
      }).catch(() => {
        if (!stopped) setCatalogueProblem("Catalogue updates are unavailable. Displayed prices and availability may be out of date.");
      }).finally(() => { pending = false; });
    }, 15000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [shopId]);

  useEffect(() => {
    if (!preferences.simple) return;
    const showLinkedStep = () => {
      const linked: Record<string, Step> = { "#shopping-cart": "cart", "#shopping-assistant": "assistant", "#shopping-messages": "messages", "#products-heading": "products" };
      const target = linked[window.location.hash];
      if (target) setStep(target);
    };
    showLinkedStep();
    window.addEventListener("hashchange", showLinkedStep);
    return () => window.removeEventListener("hashchange", showLinkedStep);
  }, [preferences.simple]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      manualGenerationRef.current++;
      transcriptionAbortRef.current?.abort();
      if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
      if (recorderRef.current) {
        recorderRef.current.onstop = null;
        recorderRef.current.onerror = null;
        if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      playbackGeneration.current++;
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  function updatePreference(key: keyof Preferences, value: boolean) {
    const next = { ...preferences, [key]: value };
    if (next.textOnly) next.readAloud = false;
    savePreferences(next);
  }

  function savePreferences(next: Preferences) {
    setPreferences(next);
    try { localStorage.setItem("kaamsaathi-shopping-preferences", JSON.stringify(next)); }
    catch { setStatus("Preferences could not be saved on this device."); }
  }

  function chooseInteraction(mode: "text" | "voice" | "visual") {
    stopPlayback();
    savePreferences({ ...preferences, textOnly: mode === "text", readAloud: mode === "voice", simple: mode !== "visual", guided: mode !== "visual" });
    setStep(orderRef.current && orderRef.current.status !== "draft" ? "cart" : "products");
    setFocusTarget({ headingId: orderRef.current && orderRef.current.status !== "draft" ? "cart-heading" : "products-heading" });
    setStatus(mode === "text"
      ? "Text and Braille mode. No audio or microphone is needed. Use Tab and Enter, switch input, or your screen reader's Braille commands. Choose quantities, then Save and review order."
      : mode === "voice" ? "Voice guidance enabled. Start a conversation when ready, or browse using the keyboard."
        : "Visual and touch mode. All shopping panels are available.");
  }

  async function ensureSession(): Promise<Order> {
    if (tokenRef.current) {
      if (orderRef.current) return orderRef.current;
      const restored = await request<Order>(shopId, "/cart", tokenRef.current);
      applyOrder(restored);
      return restored;
    }
    const session = await request<{ session_token: string; cart: Order }>(shopId, "/sessions", undefined, { method: "POST", body: body({}) });
    tokenRef.current = session.session_token;
    try { localStorage.setItem(storageKey, session.session_token); }
    catch { setStatus("Order access cannot be saved on this device. Keep this page open."); }
    applyOrder(session.cart);
    return session.cart;
  }

  async function action(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); pollGeneration.current++;
    try { await work(); }
    catch (error) {
      if (error instanceof ShoppingError && error.status === 409) {
        setReviewBlocked(true);
        if (dirtyRef.current || detailsDirtyRef.current) setEditConflict(true);
        try {
          if (tokenRef.current) applyOrder(await request<Order>(shopId, "/cart", tokenRef.current));
        } catch { /* Keep local edits and report the conflict. */ }
        setStatus("The order or prices changed. Your edits are kept. Check the latest order and review again; nothing was automatically retried.");
      } else if (error instanceof ShoppingError && error.status === 401) setSessionExpired(true);
      else setStatus(error instanceof Error ? error.message : "Something went wrong. Please try again.");
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function speak(text: string, signal?: AbortSignal, wait = false): Promise<string | null> {
    if (!tokenRef.current) await ensureSession();
    const base = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "");
    const generation = ++playbackGeneration.current;
    audioRef.current?.pause();
    const playAll = async (): Promise<string | null> => {
      let remaining = text.trim();
      while (remaining && !signal?.aborted && generation === playbackGeneration.current) {
        let length = Math.min(1200, remaining.length);
        if (length < remaining.length) {
          const split = remaining.lastIndexOf(" ", length);
          if (split > 0) length = split;
        }
        const part = remaining.slice(0, length);
        remaining = remaining.slice(length).trimStart();
        let response: Response;
        try {
          response = await fetch(`${base}/api/public/shops/${encodeURIComponent(shopId)}/voice/speak`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-Shopping-Token": tokenRef.current },
            body: body({ text: part, language }), signal, credentials: "omit", cache: "no-store",
          });
        } catch { return signal?.aborted ? "" : "Speech is unavailable. Read the text or try again."; }
        if (response.status === 401) { setSessionExpired(true); return "Saved order access has expired or is no longer valid."; }
        if (!response.ok) return "Speech is unavailable. Read the text or try again.";
        const blob = await response.blob();
        if (signal?.aborted || generation !== playbackGeneration.current) return "";
        const player = audioRef.current;
        if (!player) return "Audio controls are unavailable.";
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = URL.createObjectURL(blob); player.src = audioUrlRef.current;
        const result = await waitForPlayback(player, signal);
        if (!result.ok) return playbackStopReason(result);
      }
      return null;
    };
    if (wait) return playAll();
    void playAll().then((issue) => { if (issue && generation === playbackGeneration.current) setStatus(issue); });
    return null;
  }

  async function transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException("Recording cancelled.", "AbortError");
    await ensureSession();
    if (signal?.aborted) throw new DOMException("Recording cancelled.", "AbortError");
    const form = new FormData();
    form.append("file", audio, "recording.webm");
    form.append("language", language);
    form.append("mode", "transcribe");
    const result = await request<{ transcript: string }>(shopId, "/voice/transcribe", tokenRef.current, { method: "POST", body: form, signal });
    if (!result.transcript?.trim()) throw new Error("No speech was recognised. Try again or type your request.");
    return result.transcript;
  }

  async function askAssistant(text: string, signal?: AbortSignal, continuous = false): Promise<string | null> {
    if (dirtyRef.current || detailsDirtyRef.current) throw new Error("Save or discard your cart and contact edits before using the assistant.");
    await ensureSession();
    if (reviewBlocked && orderRef.current?.checkout_confirmation_pending) throw new Error("Review the latest order again before confirming with the assistant.");
    setConversation((lines) => [...lines, { id: uniqueId(), speaker: "You", text }]);
    let reply: AssistantResult;
    try {
      reply = await request<AssistantResult>(shopId, "/assistant", tokenRef.current, {
        method: "POST", body: body({ message: text, language, request_id: uniqueId() }), signal,
      });
    } catch (error) {
      if (error instanceof ShoppingError && error.status === 401) throw error;
      setReviewBlocked(true);
      try { applyOrder(await request<Order>(shopId, "/cart", tokenRef.current)); } catch { /* Preserve the current view. */ }
      throw new Error("The assistant request may have been processed. Check your cart and order status before sending it again; review again before confirming.");
    }
    applyOrder(reply.cart, true);
    if (reply.confirmation_required && reply.cart.checkout_confirmation_pending) setReviewBlocked(false);
    const visible = reply.text;
    setConversation((lines) => [...lines, { id: uniqueId(), speaker: "Assistant", text: visible }]);
    setStatus(`Assistant replied. Order status: ${statusLabel(reply.cart.status)}.`);
    if (!preferences.textOnly && (continuous || preferences.readAloud)) {
      const issue = await speak(visible, signal, continuous);
      if (issue) { setStatus(issue); return issue; }
    }
    return null;
  }

  const voice = useVoiceSession(async (audio, signal) => {
    if (busyRef.current) return "Another request is in progress. Start again when it finishes.";
    busyRef.current = true; setBusy(true); pollGeneration.current++;
    try {
      const transcript = await transcribe(audio, signal);
      if (signal.aborted) return "";
      return await askAssistant(transcript, signal, true);
    } catch (error) {
      if (error instanceof ShoppingError && error.status === 401) setSessionExpired(true);
      return signal.aborted ? "" : (error instanceof Error ? error.message : "Voice failed. Type instead.");
    }
    finally { busyRef.current = false; setBusy(false); }
  });

  useEffect(() => { continuousMicRef.current = voice.active; }, [voice.active]);
  notificationRef.current = (text) => {
    if (!preferences.textOnly && preferences.readAloud && !continuousMicRef.current && !manualMicRef.current) {
      void speak(text).then((issue) => { if (issue) setStatus(issue); });
    }
  };

  function stopPlayback() {
    playbackGeneration.current++;
    audioRef.current?.pause();
  }

  async function startManualRecording() {
    if (manualMicRef.current) return;
    manualMicRef.current = true;
    const generation = ++manualGenerationRef.current;
    stopPlayback();
    setRecording(true);
    setStatus("Waiting for microphone permission.");
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Recording is unavailable. Please type instead.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || generation !== manualGenerationRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      let recorder: MediaRecorder;
      try { recorder = new MediaRecorder(stream); }
      catch (error) { stream.getTracks().forEach((track) => track.stop()); streamRef.current = null; throw error; }
      recorderRef.current = recorder;
      const chunks: Blob[] = [];
      let failed = false;
      const cleanup = () => {
        if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        if (recorderRef.current === recorder) recorderRef.current = null;
        manualMicRef.current = false;
        if (mountedRef.current) setRecording(false);
      };
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => {
        failed = true;
        recorder.onstop = null;
        cleanup();
        if (recorder.state !== "inactive") recorder.stop();
        if (mountedRef.current) setStatus("Recording failed. Try again or type your request.");
      };
      recorder.onstop = () => {
        cleanup();
        if (failed || !mountedRef.current || generation !== manualGenerationRef.current) return;
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!audio.size) { setStatus("No audio was captured. Try again or type."); return; }
        const controller = new AbortController();
        transcriptionAbortRef.current = controller;
        void action(async () => {
          try {
            const text = await transcribe(audio, controller.signal);
            if (!controller.signal.aborted && mountedRef.current) { setAssistantText(text); setStatus("Transcript ready. Review or edit it before sending."); }
          } finally { if (transcriptionAbortRef.current === controller) transcriptionAbortRef.current = null; }
        });
      };
      recorder.start(); setStatus("Recording. Stop when finished; recording ends automatically after 30 seconds.");
      recordingTimerRef.current = window.setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 30000);
    } catch {
      if (generation !== manualGenerationRef.current || !mountedRef.current) return;
      manualMicRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null; recorderRef.current = null;
      setRecording(false);
      setStatus("Microphone unavailable or permission denied. Allow microphone access or type instead.");
    }
  }

  function stopManualRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else {
      manualGenerationRef.current++;
      manualMicRef.current = false;
      setRecording(false);
      setStatus("Microphone request cancelled.");
    }
  }

  function changeQuantity(id: string, value: string) {
    if (!dirtyRef.current) quantityBaseRef.current = orderRef.current?.revision ?? null;
    dirtyRef.current = true; setDirty(true);
    setQuantities((current) => ({ ...current, [id]: value }));
  }

  function saveCart(reviewAfter = false) {
    void action(async () => {
      const current = await ensureSession();
      const items = Object.entries(quantities).flatMap(([product_id, value]) => {
        const quantity = value.trim();
        if (!quantity) return [];
        if (!/^\d+(?:\.\d{1,3})?$/.test(quantity)) throw new Error("Use positive quantities with at most three decimal places, or leave the field blank to remove an item.");
        const [whole, fraction = ""] = quantity.split(".");
        const normalizedWhole = whole.replace(/^0+/, "") || "0";
        if (normalizedWhole.length > 3 || (normalizedWhole === "999" && /[1-9]/.test(fraction))) throw new Error("Quantities cannot exceed 999.");
        if (!/[1-9]/.test(quantity)) return [];
        return [{ product_id, quantity }];
      });
      if (items.length > 30) throw new Error("A cart can contain at most 30 products.");
      if (editConflict) throw new Error("Choose how to handle the changed order before saving your edits.");
      const updated = await request<Order>(shopId, "/cart", tokenRef.current, { method: "PUT", body: body({ expected_revision: quantityBaseRef.current ?? current.revision, items }) });
      if (detailsDirtyRef.current && (detailsBaseRef.current === current.revision || detailsBaseRef.current === null)) detailsBaseRef.current = updated.revision;
      dirtyRef.current = false; setDirty(false); applyOrder(updated); setReviewBlocked(true); setStatus("Cart saved with current shop prices. Review before placing your order.");
      if (reviewAfter) await reviewCurrent(updated);
    });
  }

  function saveDetails() {
    void action(async () => {
      const current = await ensureSession();
      if (editConflict) throw new Error("Choose how to handle the changed order before saving your edits.");
      const updated = await request<Order>(shopId, "/cart", tokenRef.current, { method: "PATCH", body: body({ expected_revision: detailsBaseRef.current ?? current.revision, customer_name: customerName.trim() || "Customer", notes }) });
      if (dirtyRef.current && (quantityBaseRef.current === current.revision || quantityBaseRef.current === null)) quantityBaseRef.current = updated.revision;
      applyOrder(updated); detailsDirtyRef.current = false; setDetailsDirty(false); setReviewBlocked(true); setStatus("Order details saved.");
    });
  }

  async function reviewCurrent(current: Order) {
      const updated = await request<Order>(shopId, "/cart/review", tokenRef.current, { method: "POST", body: body({ expected_revision: current.revision }) });
      applyOrder(updated); setReviewBlocked(false); setStatus("Review the current items and total. Confirm only if you wish to place the order.");
      if (preferences.simple) setStep("cart");
      setFocusTarget({ headingId: "shopping-review-heading" });
      if (!preferences.textOnly && preferences.readAloud) { const issue = await speak(cartSummary(updated, language)); if (issue) setStatus(issue); }
  }

  function review() {
    void action(async () => { await reviewCurrent(await ensureSession()); });
  }

  function submitOrder() {
    void action(async () => {
      const current = orderRef.current;
      if (!current || reviewBlocked || !current.checkout_confirmation_pending || current.reviewed_revision !== current.revision) throw new Error("Please review the order again before confirming.");
      setReviewBlocked(true);
      let updated: Order;
      try {
        updated = await request<Order>(shopId, "/checkout", tokenRef.current, { method: "POST", body: body({ expected_revision: current.revision, confirmed: true }) });
      } catch (error) {
        if (error instanceof ShoppingError && (error.status === 409 || error.status === 401)) throw error;
        try { applyOrder(await request<Order>(shopId, "/cart", tokenRef.current)); } catch { /* Leave the last visible order in place. */ }
        throw new Error("We could not confirm the result. Check the order status when connected; if it is still a draft, review it again before confirming.");
      }
      applyOrder(updated, true); setStatus(`Order submitted. Status: ${statusLabel(updated.status)}. No payment was taken.`);
      setFocusTarget({ headingId: "cart-heading" });
      if (!preferences.textOnly && preferences.readAloud) { const issue = await speak(`Order status: ${statusLabel(updated.status)}. No payment was taken.`); if (issue) setStatus(issue); }
    });
  }

  function orderDecision(path: "cancel" | "substitution", accept?: boolean) {
    void action(async () => {
      const current = orderRef.current;
      if (!current) return;
      const payload = path === "cancel" ? { expected_revision: current.revision } : { expected_revision: current.revision, accept };
      const updated = await request<Order>(shopId, `/orders/${encodeURIComponent(current.id)}/${path}`, tokenRef.current, { method: "POST", body: body(payload) });
      applyOrder(updated, true); setStatus(path === "cancel" ? "Order cancelled." : `Substitution ${accept ? "accepted" : "declined"}. Order status: ${statusLabel(updated.status)}.`);
    });
  }

  function sendMessage() {
    if (!message.trim()) return;
    void action(async () => {
      const current = await ensureSession();
      await request(shopId, `/orders/${encodeURIComponent(current.id)}/messages`, tokenRef.current, { method: "POST", body: body({ text: message.trim(), language }) });
      setMessage("");
      try { applyOrder(await request<Order>(shopId, `/orders/${encodeURIComponent(current.id)}`, tokenRef.current)); setStatus("Message sent to the shopkeeper."); }
      catch (error) {
        if (error instanceof ShoppingError && error.status === 401) setSessionExpired(true);
        setStatus("Message sent. Reconnect to refresh the conversation; do not send it again.");
      }
    });
  }

  function translateMessage(id: string, text: string, source: string) {
    void action(async () => {
      if (!["en-IN", "hi-IN", "ta-IN"].includes(source)) throw new Error("The message language is not available for translation.");
      const result = await request<{ translated_text: string }>(shopId, "/translate", tokenRef.current, { method: "POST", body: body({ text, source_language: source, target_language: language }) });
      setTranslations((current) => ({ ...current, [id]: result.translated_text })); setStatus("Translation available below the original message.");
    });
  }

  const isDraft = !order || order.status === "draft";
  const hasReview = !!order && order.status === "draft" && order.checkout_confirmation_pending && order.reviewed_revision === order.revision && !reviewBlocked && !dirty && !detailsDirty;
  const products = (shop?.products || []).filter((product) => `${product.name} ${product.category}`.toLowerCase().includes(search.toLowerCase()));
  const currentProductIndex = Math.min(productIndex, Math.max(0, products.length - 1));
  const shownProducts = preferences.guided ? products.slice(currentProductIndex, currentProductIndex + 1) : products;
  const stepIndex = steps.findIndex((item) => item.id === step);

  function goToStep(next: Step) {
    setStep(next);
    setFocusTarget({ headingId: steps.find((item) => item.id === next)!.heading });
  }

  function adjustQuantity(product: Product, change: number) {
    const value = quantities[product.id] || "0";
    if (!/^\d+(?:\.\d{1,3})?$/.test(value)) { setStatus("Correct the quantity before using increase or decrease."); return; }
    const next = Number((Number(value) + change).toFixed(3));
    if (next < 0 || next > 999 || next > Number(product.available)) { setStatus(`Choose a quantity from zero to ${Math.min(999, Number(product.available))} ${product.unit} for ${product.name}.`); return; }
    changeQuantity(product.id, next ? String(next) : "");
    setStatus(`${product.name}: ${next} ${product.unit} selected. Not yet saved. Choose Save and review order when ready.`);
  }

  function refreshUpdates() {
    void action(async () => {
      const current = await ensureSession();
      const latest = await request<Order>(shopId, `/orders/${encodeURIComponent(current.id)}`, tokenRef.current);
      applyOrder(latest);
      setPollProblem("");
      setOrderUpdate(`Latest order status: ${statusLabel(latest.status)}.${latest.proposal ? " A substitution needs your decision in Cart & order." : ""}`);
      setStatus("Order status and written messages refreshed. Use Messages to read replies.");
    });
  }

  function returnToMain() {
    if ((dirty || detailsDirty) && !window.confirm("Discard unsaved entries and return to the main app? Saved orders remain on this device.")) return;
    if (onMerchant) { onMerchant(); return; }
    try { localStorage.removeItem("kaamsaathi-customer-shop"); }
    catch { setStatus("Could not switch back to the main app. Check your browser storage settings and try again."); return; }
    window.location.assign("/");
  }

  function resetExpiredAccess() {
    if (!window.confirm("Remove saved access to this order and start again? You may no longer be able to view this order on this device.")) return;
    try { localStorage.removeItem(storageKey); }
    catch { setStatus("Could not remove saved access on this device. Check your browser storage settings."); return; }
    pollGeneration.current++;
    stopPlayback();
    tokenRef.current = ""; orderRef.current = null;
    dirtyRef.current = false; detailsDirtyRef.current = false;
    setOrder(null); setQuantities({}); setDirty(false); setCustomerName(""); setNotes(""); setDetailsDirty(false);
    setEditConflict(false); setReviewBlocked(false); setConversation([]); setTranslations({}); setOrderUpdate(""); setPollProblem("");
    setSessionExpired(false); setStatus("Saved access removed. You can start a new order.");
  }

  return <div className={`shopping ${preferences.contrast ? "shopping-contrast" : ""} ${preferences.large ? "shopping-large" : ""} ${preferences.simple ? "shopping-simple" : ""} ${preferences.textOnly ? "shopping-text-only" : ""}`}>
    <a className="shopping-skip" href="#shopping-main">Skip to shopping</a>
    <nav aria-label="App mode" className="shopping-mode-nav">
      <button type="button" className="shopping-button shopping-secondary" onClick={returnToMain}><span aria-hidden="true">&larr; </span>Back to main app</button>
      {embedded && <button type="button" className="shopping-button shopping-secondary" onClick={() => { if (!(dirty || detailsDirty) || window.confirm("Discard unsaved entries and choose another shop? Saved orders remain on this device.")) onChooseShop?.(); }}>Choose another shop</button>}
    </nav>
    <header className="shopping-header"><div className="shopping-top"><a className="shopping-brand" href="#shopping-main"><span aria-hidden="true">✦</span> KaamSaathi <small>SHOPPING</small></a><a href="#shopping-cart" onClick={(event) => { if (preferences.simple) { event.preventDefault(); goToStep("cart"); } }}>Your cart</a></div>
      <div className="shopping-hero"><div><p className="shopping-kicker">YOUR NEIGHBOURHOOD SHOP, ONLINE</p><h1>{shop?.name || "Your local shop"}</h1><p>{shop?.address || "A little more ease in your everyday shopping."}</p>{shop?.is_demo && <p>Demo shop</p>}</div><div className="shopping-hero-art" aria-hidden="true"><span>✿</span><span>◒</span><span>✦</span></div></div>
    </header>
    <main id="shopping-main" tabIndex={-1} className="shopping-main">
      <div className="shopping-intro"><div><p className="shopping-kicker">WELCOME IN</p><h2>Shop your way.</h2><p>Choose how to interact. You never need to hear or speak to place an order.</p></div><a className="shopping-button shopping-secondary" href="#shopping-assistant" onClick={(event) => { if (preferences.simple) { event.preventDefault(); goToStep("assistant"); } }}>Ask the assistant</a></div>
      <details className="shopping-section" open={!preferences.textOnly}><summary>Interaction mode: {preferences.textOnly ? "Text & Braille" : preferences.readAloud ? "Voice guidance" : "Touch or keyboard"}</summary><h2>How would you like to shop?</h2><div className="shopping-actions">
        <button className="shopping-button shopping-secondary" aria-pressed={preferences.textOnly} disabled={busy || recording || voice.active} onClick={() => chooseInteraction("text")}>Text & Braille</button>
        <button className="shopping-button shopping-secondary" aria-pressed={!preferences.textOnly && preferences.readAloud} disabled={busy || recording || voice.active} onClick={() => chooseInteraction("voice")}>Voice guidance</button>
        <button className="shopping-button shopping-secondary" aria-pressed={!preferences.textOnly && !preferences.simple && !preferences.readAloud} disabled={busy || recording || voice.active} onClick={() => chooseInteraction("visual")}>Visual & touch</button>
      </div><p>Text & Braille uses short written steps with no microphone or audio controls. Connect a refreshable Braille display through your device's screen reader if needed. The app cannot create tactile output without compatible assistive hardware.</p></details>
      <div role="status" aria-live="polite" aria-atomic="true" className="shopping-status">{status}</div>
      {sessionExpired && <div role="alert" className="shopping-status"><strong>Saved order access has expired or is no longer valid.</strong><p>Your saved access has not been removed. Ask the shopkeeper for help, or choose to remove it and start another order.</p><button type="button" className="shopping-button shopping-secondary" disabled={busy || recording || voice.active} onClick={resetExpiredAccess}>Remove saved access and start again</button></div>}
      {pollProblem && <div role="status" className="shopping-status">{pollProblem}</div>}
      {catalogueProblem && <div role="status" className="shopping-status">{catalogueProblem}</div>}
      {orderUpdate && <div role="status" className="shopping-status">{orderUpdate}</div>}
      <details className="shopping-settings"><summary>Make this easier for me <span>Optional preferences</span></summary><p>Choose any combination. Preferences stay on this device; we never ask why you use them.</p><div className="shopping-options">
        {([["readAloud", "Read aloud"], ["contrast", "High contrast"], ["large", "Large text"], ["simple", "Simple steps"], ["guided", "One product at a time"]] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={preferences[key]} disabled={key === "readAloud" && preferences.textOnly} onChange={(event) => updatePreference(key, event.target.checked)} /> {label}</label>)}
      </div></details>
      <section className="shopping-how"><div><strong>How it works</strong><p>{preferences.guided ? "Choose quantities, then Save and review order. Check the total and Confirm. Read status updates and Messages here. No payment is taken." : instructions}</p></div>{!preferences.textOnly && <button type="button" className="shopping-button shopping-secondary" disabled={busy || voice.active} onClick={() => void action(async () => { const issue = await speak(instructions); if (issue) setStatus(issue); })}>▶ Repeat instructions</button>}</section>
      <audio ref={audioRef} controls hidden={preferences.textOnly} aria-label="Speech playback controls" className="shopping-audio" />
      {preferences.simple && <nav className="shopping-steps" aria-label="Shopping steps"><p>Step {stepIndex + 1} of {steps.length}: {steps[stepIndex].label}</p><div className="shopping-actions">{steps.map((item, index) => <button key={item.id} type="button" className={`shopping-button ${step === item.id ? "" : "shopping-secondary"}`} aria-current={step === item.id ? "step" : undefined} onClick={() => goToStep(item.id)}>{index + 1}. {item.label}</button>)}</div>{!preferences.textOnly && <div className="shopping-actions"><button type="button" className="shopping-button shopping-secondary" disabled={stepIndex === 0} onClick={() => goToStep(steps[stepIndex - 1].id)}>Previous step</button><button type="button" className="shopping-button shopping-secondary" disabled={stepIndex === steps.length - 1} onClick={() => goToStep(steps[stepIndex + 1].id)}>Next step</button></div>}</nav>}
      <div className="shopping-columns"><div>
        <section aria-labelledby="products-heading" className="shopping-section" hidden={preferences.simple && step !== "products"}><div className="shopping-section-head"><div><p className="shopping-kicker">THE GOOD STUFF</p><h2 id="products-heading" tabIndex={-1}>Browse the shelves</h2><p>Illustrations represent categories, not product photos. Prices are provided by the shop.</p></div></div>
          <label className="shopping-search">Search products<input value={search} onChange={(event) => { setSearch(event.target.value); setProductIndex(0); }} placeholder="Try rice, milk, or vegetables" /></label>
          {preferences.guided && products.length > 0 && <p>Product {currentProductIndex + 1} of {products.length}. Selected quantities are kept while browsing.</p>}
          <div className="shopping-products">{shownProducts.map((product) => <article key={product.id} className="shopping-product">{!preferences.textOnly && <div className="shopping-product-art"><ProductIcon category={product.category} /></div>}<div className="shopping-product-content"><p className="shopping-category">{product.category || "Shop item"}</p><h3 id={preferences.guided ? "current-product-heading" : undefined} tabIndex={preferences.guided ? -1 : undefined}>{product.name}</h3><p className="shopping-price">{money(product.price)} <small>/ {product.unit}</small></p><p>Available: {product.available} {product.unit}{Number(product.available) <= 0 ? ". Unavailable." : ""}</p>{isDraft && <><label>Quantity ({product.unit})<input type="text" inputMode="decimal" disabled={busy || voice.active || Number(product.available) <= 0} value={quantities[product.id] || ""} onChange={(event) => changeQuantity(product.id, event.target.value)} placeholder="0" aria-label={`${product.name} quantity in ${product.unit}`} /></label>{preferences.guided && <div className="shopping-actions"><button className="shopping-button shopping-secondary" disabled={busy || voice.active || recording || !Number(quantities[product.id])} onClick={() => adjustQuantity(product, -1)}>Decrease {product.name} by one {product.unit}</button><button className="shopping-button" disabled={busy || voice.active || recording || Number(product.available) <= Number(quantities[product.id] || 0)} onClick={() => adjustQuantity(product, 1)}>Increase {product.name} by one {product.unit}</button></div>}</>}</div></article>)}</div>
          {preferences.guided && <><div className="shopping-actions"><button className="shopping-button shopping-secondary" disabled={currentProductIndex === 0 || !products.length} onClick={() => { setProductIndex(currentProductIndex - 1); setFocusTarget({ headingId: "current-product-heading" }); }}>Previous product</button><button className="shopping-button shopping-secondary" disabled={currentProductIndex >= products.length - 1} onClick={() => { setProductIndex(currentProductIndex + 1); setFocusTarget({ headingId: "current-product-heading" }); }}>Next product</button></div>{isDraft && <button className="shopping-button shopping-wide" disabled={busy || voice.active || recording || detailsDirty || (!dirty && !order?.items.length)} onClick={() => dirty ? saveCart(true) : review()}>Save and review order</button>}</>}
          {shop && products.length === 0 && <p>No products found. Try a different search or ask the shopkeeper.</p>}
        </section>
        <section id="shopping-assistant" aria-labelledby="assistant-heading" className="shopping-section shopping-assistant" hidden={preferences.simple && step !== "assistant"}><p className="shopping-kicker">HERE TO HELP</p><h2 id="assistant-heading" tabIndex={-1}>Your shopping companion</h2><p>{isDraft ? "Ask to find items, change your cart or prepare an order. You will be asked to confirm before it is placed." : "Ask about your order or products. Submitted orders cannot be edited."} Voice services may be unavailable; browsing and typing remain available.</p>
          <label>Language for speech, messages and translations<select value={language} onChange={(event) => setLanguage(event.target.value as Language)}><option value="en-IN">English</option><option value="hi-IN">Hindi</option><option value="ta-IN">Tamil</option></select></label>
          <div hidden={preferences.textOnly}><div className="shopping-actions"><button type="button" className="shopping-button" disabled={busy || recording || voice.active || sessionExpired} onClick={() => { stopPlayback(); continuousMicRef.current = true; void voice.start(); }}>Start hands-free conversation</button><button type="button" className="shopping-button shopping-secondary" disabled={!voice.active} onClick={voice.stop}>Stop conversation</button>{voice.listening && <button type="button" className="shopping-button shopping-secondary" onClick={voice.finishTurn}>Send speech now</button>}</div>
          <p role="status">{voice.status}</p><p>Hands-free sends each recognised turn to the assistant; its spoken response finishes before the microphone resumes. Say yes only when you approve the reviewed order.</p>
          <div className="shopping-actions"><button type="button" className="shopping-button shopping-secondary" disabled={busy || voice.active || recording || sessionExpired} onClick={() => void startManualRecording()}>Record a request</button><button type="button" className="shopping-button shopping-secondary" disabled={!recording} onClick={stopManualRecording}>Stop and review transcript</button></div></div>
          <label>Your request or transcript<textarea value={assistantText} onChange={(event) => setAssistantText(event.target.value)} placeholder={isDraft ? "For example: add one packet of rice" : "For example: what is my order status?"} /></label><button type="button" className="shopping-button" disabled={busy || voice.active || recording || !assistantText.trim() || sessionExpired} onClick={() => { const text = assistantText.trim(); setAssistantText(""); void action(async () => { await askAssistant(text); }); }}>Send to assistant</button>
          <div className="shopping-conversation" role="log" aria-label="Assistant conversation" aria-live="polite">{conversation.map((line) => <p key={line.id}><strong>{line.speaker}: </strong>{line.text}</p>)}</div>
        </section>
      </div><aside>
        <section id="shopping-cart" aria-labelledby="cart-heading" className="shopping-section shopping-cart" hidden={preferences.simple && step !== "cart"}><p className="shopping-kicker">YOUR BASKET</p><h2 id="cart-heading" tabIndex={-1}>{isDraft ? "Your cart" : "Your order"}</h2><p>Status: <strong>{order ? statusLabel(order.status) : "Not started"}</strong></p>
          {order && <p>Order reference: <strong>{order.id.slice(0, 8)}</strong>. Share this reference with the shopkeeper.</p>}
          {order?.items.length ? <ul className="shopping-lines">{order.items.map((item) => <li key={item.product_id}><div><strong>{item.name}</strong><br />{item.quantity} {item.unit} × {money(item.unit_price)}{isDraft && <><label>Change {item.name} quantity ({item.unit})<input type="text" inputMode="decimal" disabled={busy || voice.active} value={quantities[item.product_id] || ""} onChange={(event) => changeQuantity(item.product_id, event.target.value)} /></label><button type="button" className="shopping-button shopping-secondary" disabled={busy || voice.active} onClick={() => changeQuantity(item.product_id, "")}>Remove {item.name}</button></>}</div><strong>{money(item.line_total)}</strong></li>)}</ul> : <p>Your cart is empty. Choose quantities from the shelves.</p>}
          <div className="shopping-total"><span>Total</span><strong>{order ? money(order.total) : "—"}</strong></div><p>Totals come from the shop and can change when reviewed.</p>
          {isDraft && <><div className="shopping-actions"><button type="button" className="shopping-button" disabled={busy || voice.active || recording || !dirty} onClick={() => saveCart()}>Save cart quantities</button><button type="button" className="shopping-button shopping-secondary" disabled={!dirty || busy} onClick={() => { setQuantities(Object.fromEntries((orderRef.current?.items || []).map((item) => [item.product_id, item.quantity]))); dirtyRef.current = false; setDirty(false); if (!detailsDirtyRef.current) setEditConflict(false); setStatus("Unsaved quantities discarded."); }}>Discard quantity edits</button></div>
            <label>Name for the order (optional)<input disabled={busy || voice.active} value={customerName} onChange={(event) => { if (!detailsDirtyRef.current) detailsBaseRef.current = orderRef.current?.revision ?? null; setCustomerName(event.target.value); detailsDirtyRef.current = true; setDetailsDirty(true); }} /></label><label>Notes for the shopkeeper (optional)<textarea disabled={busy || voice.active} value={notes} onChange={(event) => { if (!detailsDirtyRef.current) detailsBaseRef.current = orderRef.current?.revision ?? null; setNotes(event.target.value); detailsDirtyRef.current = true; setDetailsDirty(true); }} /></label><div className="shopping-actions"><button type="button" className="shopping-button shopping-secondary" disabled={busy || voice.active || !detailsDirty} onClick={saveDetails}>Save details</button><button type="button" className="shopping-button shopping-secondary" disabled={busy || !detailsDirty} onClick={() => { setCustomerName(orderRef.current?.customer_name || ""); setNotes(orderRef.current?.notes || ""); detailsDirtyRef.current = false; setDetailsDirty(false); if (!dirtyRef.current) setEditConflict(false); }}>Discard detail edits</button></div>
            {editConflict && <div className="shopping-review"><p>The order changed while you were editing. Compare your entries with the saved cart above. You can discard your edits or keep them and replace the latest saved values.</p><button type="button" className="shopping-button shopping-secondary" disabled={busy} onClick={() => { quantityBaseRef.current = orderRef.current?.revision ?? null; detailsBaseRef.current = orderRef.current?.revision ?? null; setEditConflict(false); setStatus("Your edits now use the latest order revision. Save them when ready."); }}>Keep my edits using latest revision</button></div>}
            {(dirty || detailsDirty) && <p>Save or discard your edits before review.</p>}<button type="button" className="shopping-button shopping-wide" disabled={busy || voice.active || recording || dirty || detailsDirty || !order?.items.length} onClick={review}>Review order</button>
            {hasReview && <div className="shopping-review"><h3 id="shopping-review-heading" tabIndex={-1}>Review before confirming</h3><ul aria-label="Reviewed items">{order.items.map((item) => <li key={item.product_id}>{item.name}: {item.quantity} {item.unit}, {money(item.line_total)}</li>)}</ul><p><strong>Order total: {money(order.total)}</strong></p><p>The shopkeeper must accept your order. There is no online payment. Confirm only if these details are correct.</p><button type="button" className="shopping-button shopping-wide" disabled={busy || voice.active} onClick={submitOrder}>Confirm and place order</button></div>}
          </>}
          {!isDraft && <><p>Payment is arranged with the shop, not here.</p>{["pending_shopkeeper_confirmation", "accepted", "ready_for_collection"].includes(order.status) && <button type="button" className="shopping-button shopping-secondary" disabled={busy} onClick={() => { if (window.confirm("Cancel this order?")) orderDecision("cancel"); }}>Cancel order</button>}</>}
          {order && <><button className="shopping-button shopping-secondary" aria-disabled={busy} aria-busy={busy} onClick={refreshUpdates}>Check order updates</button><h3>Order history</h3><ol>{order.events.map((entry) => <li key={entry.id}><strong>{statusLabel(entry.status)}</strong>: {entry.note}</li>)}</ol><button className="shopping-button shopping-secondary" onClick={() => goToStep("messages")}>Read or send written messages</button></>}
          {order?.proposal && <div className="shopping-review"><h3>Shopkeeper suggests a substitution</h3><p>{order.proposal.replacement_name}, {order.proposal.quantity} {order.proposal.replacement_unit} at {money(order.proposal.unit_price)}. {order.proposal.note}</p><ul>{order.proposal.items.map((item) => <li key={item.product_id}>{item.name}: {item.quantity} {item.unit} — {money(item.line_total)}</li>)}</ul><p>Proposed total: <strong>{money(order.proposal.total)}</strong></p><div className="shopping-actions"><button type="button" className="shopping-button" disabled={busy} onClick={() => orderDecision("substitution", true)}>Accept substitution</button><button type="button" className="shopping-button shopping-secondary" disabled={busy} onClick={() => orderDecision("substitution", false)}>Decline substitution</button></div></div>}
          {order && terminal.includes(order.status) && <button type="button" className="shopping-button shopping-secondary" disabled={busy} onClick={() => { if (window.confirm("Start another order? This replaces saved access to this order on this device.")) { try { localStorage.removeItem(storageKey); } catch { setStatus("Could not clear saved order access on this device."); return; } tokenRef.current = ""; orderRef.current = null; setOrder(null); setQuantities({}); setCustomerName(""); setNotes(""); setConversation([]); setStatus("Ready for a new order."); } }}>Start another order</button>}
          <p className="shopping-privacy">Your private order access is saved on this device for up to seven days. Anyone using this device may be able to view it. Clearing browser data or starting another order removes saved access. No login or app installation is required.</p>
        </section>
        <section id="shopping-messages" className="shopping-section" aria-labelledby="messages-heading" hidden={preferences.simple && step !== "messages"}><p className="shopping-kicker">STAY IN TOUCH</p><h2 id="messages-heading" tabIndex={-1}>Message the shopkeeper</h2><p>Messages are visible to the shopkeeper, even before ordering.</p>
          <label>Common phrases<select defaultValue="" onChange={(event) => { if (event.target.value) setMessage(event.target.value); }}><option value="">Choose a phrase</option>{phrases.map((phrase) => <option key={phrase} value={phrase}>{phrase}</option>)}</select></label>
          <label>Message<textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1000} /></label><div className="shopping-actions"><button type="button" className="shopping-button" disabled={busy || !message.trim()} onClick={sendMessage}>Send message</button>{!preferences.textOnly && <button type="button" className="shopping-button shopping-secondary" disabled={busy || voice.active || !message.trim()} onClick={() => void action(async () => { const issue = await speak(message); if (issue) setStatus(issue); })}>▶ Speak message</button>}<button className="shopping-button shopping-secondary" aria-disabled={busy} aria-busy={busy} onClick={refreshUpdates}>Refresh written replies</button></div>
          <div role="log" aria-label="Written conversation" aria-live="polite" className="shopping-conversation">{order?.messages.map((entry) => <div key={entry.id} className="shopping-message"><strong>{entry.sender === "customer" ? "You" : "Shopkeeper"}</strong><p lang={entry.language}>{entry.text}</p>{translations[entry.id] && <p>Translation: {translations[entry.id]}</p>}<div className="shopping-actions"><button type="button" className="shopping-button shopping-secondary" disabled={busy} onClick={() => translateMessage(entry.id, entry.text, entry.language)}>Translate</button>{!preferences.textOnly && <button type="button" className="shopping-button shopping-secondary" disabled={busy || voice.active} onClick={() => void action(async () => { const issue = await speak(translations[entry.id] || entry.text); if (issue) setStatus(issue); })}>▶ Read aloud</button>}</div></div>)}</div>
        </section>
      </aside></div>
      <footer className="shopping-footer">Made for everyday shopping · No payment taken online</footer>
    </main>
  </div>;
}
