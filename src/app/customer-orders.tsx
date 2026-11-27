"use client";

import {
  AlertTriangle, Check, ChevronRight, Languages,
  MessageCircle, Mic, Package, RefreshCw, Send, Volume2, X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./customer-orders.module.css";

type Language = "hi-IN" | "en-IN" | "ta-IN";
type OrderStatus = "draft" | "pending_shopkeeper_confirmation" | "accepted" | "rejected" | "ready_for_collection" | "completed" | "cancelled";
type OrderItem = { product_id: string; name: string; unit: string; quantity: string; unit_price: string; line_total: string };
type OrderMessage = { id: string; sender: "customer" | "shopkeeper"; text: string; language: string; created_at: string };
type Order = {
  id: string; shop_id: string; status: OrderStatus; revision: number; reviewed_revision: number | null;
  checkout_confirmation_pending: boolean; total: string; items: OrderItem[]; customer_name: string;
  notes: string; created_at: string; updated_at: string; sale_id: string | null;
  proposal: null | { original_product_id: string; replacement_product_id: string; quantity: string; replacement_name: string; replacement_unit: string; unit_price: string; total: string; note: string; items: OrderItem[] };
  messages: OrderMessage[]; events: { id: string; status: string; note: string; created_at: string }[];
};
type ShopLink = { shop_id: string; shop_name: string; url: string; path: string; qr_path: string; pending_count: number; local_only: boolean };
type Product = { id: string; name: string; unit: string; stock: string; selling_price: string };
type Props = {
  token: string;
  preferredLanguage: string;
  apiRequest: <T>(path: string, token: string, options?: RequestInit) => Promise<T>;
  onRecordStart: () => void;
  onStartShopping: () => void;
};
type Filter = "all" | "needs_review" | "enquiries";

const LANGUAGES: { code: Language; name: string }[] = [
  { code: "hi-IN", name: "Hindi" }, { code: "en-IN", name: "English" }, { code: "ta-IN", name: "Tamil" },
];
const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Customer enquiry", pending_shopkeeper_confirmation: "Awaiting your review", accepted: "Accepted",
  rejected: "Rejected", ready_for_collection: "Ready for collection", completed: "Completed",
  cancelled: "Cancelled",
};
const TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  pending_shopkeeper_confirmation: ["accepted", "rejected", "cancelled"],
  accepted: ["ready_for_collection", "cancelled"],
  ready_for_collection: ["completed", "cancelled"],
};
const money = (value: string | number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const dateTime = (value: string) => new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const quantityText = (item: OrderItem) => `${item.quantity} ${item.unit}`;

export default function CustomerOrders({ token, preferredLanguage, apiRequest, onRecordStart, onStartShopping }: Props) {
  const [shopLink, setShopLink] = useState<ShopLink | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const selectedIdRef = useRef("");
  const previousOrders = useRef<Map<string, string> | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [pageError, setPageError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [messageLanguage, setMessageLanguage] = useState<Language>(() => LANGUAGES.find((item) => item.code === preferredLanguage)?.code || "hi-IN");
  const [messageBusy, setMessageBusy] = useState(false);
  const [messageError, setMessageError] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [translationTarget, setTranslationTarget] = useState<Language>(() => LANGUAGES.find((item) => item.code === preferredLanguage)?.code || "hi-IN");
  const [translations, setTranslations] = useState<Record<string, { text: string; language: string }>>({});
  const [voiceError, setVoiceError] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [action, setAction] = useState<OrderStatus | null>(null);
  const [actionNote, setActionNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "upi" | "">("");
  const [paymentCollected, setPaymentCollected] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [substitutionOpen, setSubstitutionOpen] = useState(false);
  const [originalProductId, setOriginalProductId] = useState("");
  const [replacementProductId, setReplacementProductId] = useState("");
  const [substitutionQuantity, setSubstitutionQuantity] = useState("");
  const [substitutionNote, setSubstitutionNote] = useState("");
  const [substitutionBusy, setSubstitutionBusy] = useState(false);
  const [substitutionError, setSubstitutionError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const recordedChunks = useRef<Blob[]>([]);
  const recordingTimeout = useRef<number | null>(null);
  const recordingGeneration = useRef(0);
  const audio = useRef<HTMLAudioElement>(null);

  const fetchOrder = useCallback(async (id: string, quiet = false) => {
    if (!id) return;
    if (!quiet) setLoadingDetail(true);
    try {
      const [detail, messages] = await Promise.all([
        apiRequest<Order>(`/api/shopping/orders/${encodeURIComponent(id)}`, token),
        apiRequest<OrderMessage[]>(`/api/shopping/orders/${encodeURIComponent(id)}/messages`, token),
      ]);
      if (selectedIdRef.current !== id) return;
      setOrder({ ...detail, messages });
      setDetailError("");
    } catch (error) {
      if (selectedIdRef.current !== id) return;
      setDetailError(error instanceof Error ? error.message : "Could not load this order. Please refresh.");
    } finally {
      if (!quiet && selectedIdRef.current === id) setLoadingDetail(false);
    }
  }, [apiRequest, token]);

  const fetchQueue = useCallback(async (quiet = false) => {
    if (!quiet) setLoadingQueue(true);
    try {
      const [rows, link] = await Promise.all([
        apiRequest<Order[]>("/api/shopping/orders", token),
        apiRequest<ShopLink>("/api/shopping/link", token),
      ]);
      const snapshot = new Map(rows.map((item) => [item.id, `${item.status}:${item.updated_at}`]));
      const previous = previousOrders.current;
      if (previous) {
        const newOrders = rows.filter((item) => !previous.has(item.id));
        const changed = rows.filter((item) => previous.has(item.id) && previous.get(item.id) !== `${item.status}:${item.updated_at}`);
        const updates = [
          ...newOrders.map((item) => `New ${item.status === "draft" ? "customer enquiry" : "customer order"} from ${item.customer_name || "a customer"}.`),
          ...changed.map((item) => `${item.customer_name || "Customer"}'s order is now ${STATUS_LABEL[item.status]}.`),
        ];
        if (updates.length) setAnnouncement(updates.slice(0, 3).join(" "));
      }
      previousOrders.current = snapshot;
      setOrders(rows);
      setShopLink(link);
      setPageError("");
      if (!selectedIdRef.current && rows.length) {
        selectedIdRef.current = rows[0].id;
        setSelectedId(rows[0].id);
      }
      if (selectedIdRef.current && !rows.some((item) => item.id === selectedIdRef.current)) {
        selectedIdRef.current = "";
        setSelectedId("");
        setOrder(null);
      }
      return rows;
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not load customer orders. Please try again.");
      return null;
    } finally {
      if (!quiet) setLoadingQueue(false);
    }
  }, [apiRequest, token]);

  useEffect(() => {
    void fetchQueue();
    apiRequest<Product[]>("/api/products", token).then(setProducts).catch(() => setSubstitutionError("Product choices could not be loaded. Refresh and try again."));
  }, [apiRequest, fetchQueue, token]);

  useEffect(() => {
    if (selectedId) void fetchOrder(selectedId);
  }, [fetchOrder, selectedId]);

  useEffect(() => {
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void fetchQueue(true);
      if (selectedIdRef.current) void fetchOrder(selectedIdRef.current, true);
    };
    const timer = window.setInterval(poll, 10000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [fetchOrder, fetchQueue]);

  useEffect(() => {
    if (!audioUrl) return;
    return () => URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => () => {
    if (recordingTimeout.current !== null) window.clearTimeout(recordingTimeout.current);
    recordingGeneration.current++;
    if (recorder.current?.state === "recording") {
      recorder.current.onstop = null;
      recorder.current.onerror = null;
      recorder.current.stop();
    }
    mediaStream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function chooseOrder(id: string) {
    if (id !== selectedIdRef.current) {
      discardRecording();
      setMessageDraft("");
      setMessageError("");
      setVoiceError("");
    }
    selectedIdRef.current = id;
    setSelectedId(id);
    setOrder(null);
    setDetailError("");
    setAction(null);
    setSubstitutionOpen(false);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = messageDraft.trim();
    if (!order || !text || messageBusy) return;
    setMessageBusy(true);
    setMessageError("");
    try {
      await apiRequest<OrderMessage>(`/api/shopping/orders/${encodeURIComponent(order.id)}/messages`, token, {
        method: "POST", body: JSON.stringify({ text, language: messageLanguage }),
      });
      setMessageDraft("");
      await fetchOrder(order.id, true);
      setAnnouncement("Your written reply was sent.");
    } catch (error) {
      setMessageError(error instanceof Error ? error.message : "Your reply could not be sent. Please try again.");
    } finally {
      setMessageBusy(false);
    }
  }

  async function beginRecording() {
    setVoiceError("");
    const orderId = selectedIdRef.current;
    if (!orderId || recording || transcribing) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceError("Audio recording is not supported in this browser. You can type a written reply instead.");
      return;
    }
    const generation = ++recordingGeneration.current;
    let openedStream: MediaStream | null = null;
    onRecordStart();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      openedStream = stream;
      if (generation !== recordingGeneration.current || selectedIdRef.current !== orderId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStream.current = stream;
      recordedChunks.current = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined;
      const capture = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      capture.ondataavailable = (event) => { if (event.data.size) recordedChunks.current.push(event.data); };
      capture.onerror = () => {
        recordingGeneration.current++;
        if (recordingTimeout.current !== null) window.clearTimeout(recordingTimeout.current);
        recordingTimeout.current = null;
        capture.onstop = null;
        capture.ondataavailable = null;
        recordedChunks.current = [];
        setVoiceError("Recording failed. Please try again or type your reply.");
        setRecording(false);
        stream.getTracks().forEach((track) => track.stop());
        mediaStream.current = null;
        recorder.current = null;
      };
      capture.onstop = () => {
        if (recordingTimeout.current !== null) window.clearTimeout(recordingTimeout.current);
        recordingTimeout.current = null;
        setRecording(false);
        stream.getTracks().forEach((track) => track.stop());
        mediaStream.current = null;
        const blob = new Blob(recordedChunks.current, { type: capture.mimeType || "audio/webm" });
        recordedChunks.current = [];
        if (blob.size && generation === recordingGeneration.current && selectedIdRef.current === orderId) {
          void transcribeReply(blob, orderId, generation);
        }
      };
      capture.start();
      setRecording(true);
      recordingTimeout.current = window.setTimeout(() => {
        if (capture.state === "recording") capture.stop();
      }, 30_000);
    } catch {
      if (recordingTimeout.current !== null) window.clearTimeout(recordingTimeout.current);
      recordingTimeout.current = null;
      if (recorder.current) {
        recorder.current.onstop = null;
        recorder.current.onerror = null;
        if (recorder.current.state === "recording") recorder.current.stop();
      }
      openedStream?.getTracks().forEach((track) => track.stop());
      mediaStream.current = null;
      recorder.current = null;
      recordedChunks.current = [];
      setRecording(false);
      setVoiceError("Microphone could not start. Check permission or try typing your reply.");
    }
  }

  function discardRecording() {
    recordingGeneration.current++;
    if (recordingTimeout.current !== null) window.clearTimeout(recordingTimeout.current);
    recordingTimeout.current = null;
    const active = recorder.current;
    if (active) {
      active.onstop = null;
      active.onerror = null;
      if (active.state === "recording") active.stop();
    }
    mediaStream.current?.getTracks().forEach((track) => track.stop());
    mediaStream.current = null;
    recorder.current = null;
    recordedChunks.current = [];
    setRecording(false);
    setTranscribing(false);
  }

  async function transcribeReply(blob: Blob, orderId: string, generation: number) {
    setTranscribing(true);
    setVoiceError("");
    try {
      const form = new FormData();
      form.append("file", blob, blob.type.includes("mp4") ? "shopkeeper-reply.mp4" : "shopkeeper-reply.webm");
      form.append("mode", "transcribe");
      form.append("language", messageLanguage);
      const result = await apiRequest<{ transcript: string }>("/api/voice/transcribe", token, { method: "POST", body: form });
      if (generation !== recordingGeneration.current || selectedIdRef.current !== orderId) return;
      if (!result.transcript.trim()) throw new Error("No speech was recognised. Try recording again or type your reply.");
      setMessageDraft((current) => current ? `${current} ${result.transcript.trim()}` : result.transcript.trim());
    } catch (error) {
      if (generation !== recordingGeneration.current || selectedIdRef.current !== orderId) return;
      setVoiceError(error instanceof Error ? error.message : "Transcription failed. Your message was not sent.");
    } finally {
      if (generation === recordingGeneration.current && selectedIdRef.current === orderId) setTranscribing(false);
    }
  }

  async function translateMessage(message: OrderMessage) {
    setVoiceError("");
    try {
      if (!LANGUAGES.some((item) => item.code === message.language)) throw new Error("This message language is not supported for translation.");
      if (message.language === translationTarget) {
        setTranslations((current) => ({ ...current, [message.id]: { text: message.text, language: translationTarget } }));
        return;
      }
      const result = await apiRequest<{ translated_text: string; target_language: string }>("/api/translation", token, {
        method: "POST",
        body: JSON.stringify({ text: message.text, source_language: message.language, target_language: translationTarget }),
      });
      setTranslations((current) => ({ ...current, [message.id]: { text: result.translated_text, language: result.target_language } }));
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Translation failed. The original message is unchanged.");
    }
  }

  async function speak(text: string, language: string) {
    setVoiceError("");
    try {
      const response = await apiRequest<Response>("/api/voice/speak", token, {
        method: "POST", body: JSON.stringify({ text, language }),
      });
      const nextUrl = URL.createObjectURL(await response.blob());
      setAudioUrl(nextUrl);
      window.setTimeout(() => { void audio.current?.play().catch(() => setVoiceError("Audio is ready. Use the audio controls to play it.")); }, 0);
    } catch (error) {
      setVoiceError(error instanceof Error ? error.message : "Audio could not be prepared. The written text is still available.");
    }
  }

  function stageAction(next: OrderStatus) {
    setAction(next);
    setActionNote("");
    setPaymentMethod("");
    setPaymentCollected(false);
    setActionError("");
  }

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!order || !action || actionBusy) return;
    if (action === "rejected" && !actionNote.trim()) {
      setActionError("Please enter a reason before rejecting this order.");
      return;
    }
    if (action === "completed" && (!paymentCollected || !paymentMethod)) {
      setActionError("Confirm that payment was already collected and choose cash or UPI.");
      return;
    }
    setActionBusy(true);
    setActionError("");
    try {
      await apiRequest<Order>(`/api/shopping/orders/${encodeURIComponent(order.id)}/status`, token, {
        method: "POST",
        body: JSON.stringify({
          expected_revision: order.revision,
          status: action,
          ...(actionNote.trim() ? { note: actionNote.trim() } : {}),
          ...(action === "completed" ? { payment_method: paymentMethod } : {}),
        }),
      });
      setAction(null);
      setAnnouncement(action === "completed" ? "Order completed and collected payment recorded as a sale." : `Order ${STATUS_LABEL[action].toLowerCase()}.`);
      await Promise.all([fetchOrder(order.id, true), fetchQueue(true)]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The order could not be updated.");
      setAction(null);
      await Promise.all([fetchOrder(order.id, true), fetchQueue(true)]);
      setAnnouncement("The order may have changed. Latest details refreshed; no status change was retried.");
    } finally {
      setActionBusy(false);
    }
  }

  function openSubstitution(item: OrderItem) {
    setOriginalProductId(item.product_id);
    setReplacementProductId("");
    setSubstitutionQuantity(item.quantity);
    setSubstitutionNote("");
    setSubstitutionError("");
    setSubstitutionOpen(true);
  }

  async function submitSubstitution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!order || substitutionBusy) return;
    if (!originalProductId || !replacementProductId) {
      setSubstitutionError("Choose the ordered item and its replacement before sending the proposal.");
      return;
    }
    setSubstitutionBusy(true);
    setSubstitutionError("");
    try {
      await apiRequest<Order>(`/api/shopping/orders/${encodeURIComponent(order.id)}/substitutions`, token, {
        method: "POST",
        body: JSON.stringify({
          expected_revision: order.revision, product_id: originalProductId,
          replacement_product_id: replacementProductId, quantity: substitutionQuantity,
          note: substitutionNote.trim(),
        }),
      });
      setSubstitutionOpen(false);
      setAnnouncement("Replacement proposal sent for customer consent. The original order remains unchanged until they respond.");
      await Promise.all([fetchOrder(order.id, true), fetchQueue(true)]);
    } catch (error) {
      setSubstitutionError(error instanceof Error ? error.message : "The replacement proposal could not be sent.");
      setSubstitutionOpen(false);
      await Promise.all([fetchOrder(order.id, true), fetchQueue(true)]);
    } finally {
      setSubstitutionBusy(false);
    }
  }

  const visibleOrders = orders.filter((item) => {
    if (filter === "needs_review") return item.status === "pending_shopkeeper_confirmation";
    if (filter === "enquiries") return item.status === "draft";
    return true;
  });
  const selectableProducts = products.filter((item) => item.id !== originalProductId);
  const transitionButtons = order ? TRANSITIONS[order.status] || [] : [];
  const isEnquiry = order?.status === "draft";
  const hasProposal = Boolean(order?.proposal);

  return <section className={styles.page} aria-label="Customer orders">
    <div className={styles.heading}>
      <div>
        <h1>Customer orders</h1>
        <p>Start in-app customer shopping, review requests, and reply in writing or by voice.</p>
      </div>
      <button className="button button-secondary" onClick={() => { void fetchQueue(); if (selectedIdRef.current) void fetchOrder(selectedIdRef.current); }}>
        <RefreshCw size={16} /> Refresh
      </button>
    </div>
    <div className={styles.announcer} role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    {pageError && <div className={styles.error} role="alert"><AlertTriangle size={18} />{pageError}</div>}

    <section className={styles.shopCard} aria-labelledby="shop-link-title">
      <div className={styles.shopInfo}>
        <h2 id="shop-link-title">{shopLink?.shop_name || "Your shop"}: customer mode</h2>
        <p>Hand this device to a customer to shop here, without a QR code or another page. Shopkeeper access is locked first; sign in again to manage orders.</p>
        <button className="button button-primary" onClick={onStartShopping}>Start customer shopping</button>
      </div>
      <div className={styles.pendingCount}><strong>{shopLink?.pending_count ?? 0}</strong><span>awaiting review</span></div>
    </section>

    <div className={styles.workspace}>
      <section className={styles.queue} aria-labelledby="queue-title">
        <div className={styles.sectionHeading}><div><h2 id="queue-title">Order queue</h2><p>Enquiries are not completed sales.</p></div><span className={styles.queueCount}>{visibleOrders.length}</span></div>
        <label className={styles.filterLabel} htmlFor="order-filter">Show orders</label>
        <select id="order-filter" className={styles.filter} value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
          <option value="all">All requests</option><option value="needs_review">Awaiting review</option><option value="enquiries">Draft enquiries</option>
        </select>
        {loadingQueue && <p className={styles.empty}>Loading requests…</p>}
        {!loadingQueue && visibleOrders.length === 0 && <p className={styles.empty}>{filter === "all" ? "No customer requests yet." : "No requests in this filter."}</p>}
        <ul className={styles.orderList} aria-label="Customer requests">
          {visibleOrders.map((item) => <li key={item.id}>
            <button type="button" className={`${styles.orderButton} ${selectedId === item.id ? styles.selected : ""}`} aria-current={selectedId === item.id ? "true" : undefined} onClick={() => chooseOrder(item.id)}>
              <span className={styles.orderTop}><strong>{item.customer_name || "Customer"}</strong><span className={`${styles.status} ${item.status === "draft" ? styles.enquiry : ""}`}>{STATUS_LABEL[item.status]}</span></span>
              <span className={styles.orderBottom}><span>{item.status === "draft" ? "Enquiry" : money(item.total)}</span><span>{new Date(item.updated_at).toLocaleDateString("en-IN")}</span></span>
              <span className={styles.orderMeta}>{item.items.length} item{item.items.length === 1 ? "" : "s"} · {item.messages.length} message{item.messages.length === 1 ? "" : "s"}</span>
              <span className={styles.orderMeta}>Reference {item.id.slice(0, 8)}</span>
              <ChevronRight className={styles.orderArrow} size={16} />
            </button>
          </li>)}
        </ul>
      </section>

      <section className={styles.detail} aria-labelledby="detail-title">
        {!selectedId && <div className={styles.emptyDetail}><Package size={28} /><h2 id="detail-title">Select a customer request</h2><p>Requests and draft enquiries will appear here.</p></div>}
        {selectedId && loadingDetail && !order && <p className={styles.empty}>Loading request details…</p>}
        {selectedId && detailError && <div className={styles.error} role="alert">{detailError}</div>}
        {order && <>
          <div className={styles.sectionHeading}><div>
            <p className={styles.eyebrow}>{isEnquiry ? "Draft enquiry · not a sale" : `Order ${order.id.slice(0, 8)}`}</p>
            <h2 id="detail-title">{order.customer_name || "Customer"}</h2>
            <p>{STATUS_LABEL[order.status]} · Received {dateTime(order.created_at)}</p>
          </div><span className={`${styles.status} ${isEnquiry ? styles.enquiry : ""}`}>{STATUS_LABEL[order.status]}</span></div>
          {order.notes && <p className={styles.notes}><strong>Customer note:</strong> {order.notes}</p>}
          {order.checkout_confirmation_pending && <div className={styles.info} role="note">Customer checkout confirmation is pending. Review the request and customer messages before taking action.</div>}

          <div className={styles.items}>
            <h3>{isEnquiry ? "Enquiry items" : "Requested items"}</h3>
            {order.items.map((item) => <div className={styles.item} key={`${item.product_id}-${item.name}`}>
              <div><strong>{item.name}</strong><span>{quantityText(item)} × {money(item.unit_price)}</span></div><strong>{money(item.line_total)}</strong>
            </div>)}
            <div className={styles.total}><span>{isEnquiry ? "Current estimate" : "Order total"}</span><strong>{money(order.total)}</strong></div>
          </div>

          {order.proposal && <div className={styles.proposal} role="status">
            <strong>Replacement proposed — waiting for customer consent</strong>
            <p>{order.proposal.quantity} × {order.proposal.replacement_name} ({order.proposal.replacement_unit}) at {money(order.proposal.unit_price)} each</p>
            <p>Proposed total: <strong>{money(order.proposal.total)}</strong></p>
            {order.proposal.note && <p>Note: {order.proposal.note}</p>}
            <p>The existing requested items and total are unchanged until the customer approves.</p>
          </div>}
          {actionError && !action && <p className={styles.errorText} role="alert">{actionError}</p>}
          {substitutionError && !substitutionOpen && <p className={styles.errorText} role="alert">{substitutionError}</p>}

          {!isEnquiry && <div className={styles.actions}>
            {transitionButtons.map((next) => {
              const blocked = next === "accepted" && hasProposal;
              const label: Record<string, string> = { accepted: "Accept order", rejected: "Reject order", ready_for_collection: "Mark ready for collection", completed: "Complete & record collected payment", cancelled: "Cancel order" };
              return <button key={next} type="button" className={next === "rejected" || next === "cancelled" ? "button button-secondary" : "button button-primary"} disabled={blocked} title={blocked ? "Wait for the customer to approve or decline the replacement." : undefined} onClick={() => stageAction(next)}>
                {next === "accepted" ? <Check size={16} /> : next === "completed" ? <Check size={16} /> : <X size={16} />}{label[next]}
              </button>;
            })}
            {order.status === "pending_shopkeeper_confirmation" && <button type="button" className="button button-secondary" onClick={() => {
              if (substitutionOpen) setSubstitutionOpen(false);
              else if (order.items[0]) openSubstitution(order.items[0]);
            }}>
              <Package size={16} /> Propose replacement
            </button>}
          </div>}
          {hasProposal && order.status === "pending_shopkeeper_confirmation" && <p className={styles.info}>Acceptance is unavailable until the customer approves or declines this proposal.</p>}

          {action && <form className={styles.review} onSubmit={(event) => void submitAction(event)} aria-labelledby="review-title">
            <h3 id="review-title">Review before updating</h3>
            <p>{action === "completed"
              ? "This records one itemised sale and deducts inventory. Use only after the customer has already paid at the counter; this does not take or process an online payment."
              : action === "cancelled"
                ? "Cancellation releases any reserved stock. It does not create a sale or reverse an existing ledger entry."
                : `You are about to mark this order ${STATUS_LABEL[action].toLowerCase()}.`}</p>
            {action === "rejected" && <label className={styles.field}>Written reason for rejection<textarea required value={actionNote} onChange={(event) => setActionNote(event.target.value)} rows={3} /></label>}
            {action === "completed" && <>
              <label className={styles.field}>Payment collected as<select required value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as "cash" | "upi" | "")}><option value="">Choose payment type</option><option value="cash">Cash collected at counter</option><option value="upi">UPI already collected at counter</option></select></label>
              <label className={styles.check}><input type="checkbox" checked={paymentCollected} onChange={(event) => setPaymentCollected(event.target.checked)} /> I confirm payment was already collected at the counter. I am not initiating an online payment.</label>
            </>}
            {action !== "rejected" && <label className={styles.field}>Note (optional)<textarea value={actionNote} onChange={(event) => setActionNote(event.target.value)} rows={2} /></label>}
            {actionError && <p className={styles.errorText} role="alert">{actionError}</p>}
            <div className={styles.reviewActions}><button type="button" className="button button-secondary" disabled={actionBusy} onClick={() => setAction(null)}>Go back</button>
              <button type="submit" className="button button-primary" disabled={actionBusy || (action === "completed" && (!paymentCollected || !paymentMethod))}>{actionBusy ? "Saving…" : action === "completed" ? "Confirm & record collected payment" : `Confirm ${STATUS_LABEL[action].toLowerCase()}`}</button></div>
          </form>}

          {substitutionOpen && order.status === "pending_shopkeeper_confirmation" && <form className={styles.review} onSubmit={(event) => void submitSubstitution(event)} aria-labelledby="substitution-title">
            <h3 id="substitution-title">Propose a replacement</h3>
            <p>The customer must approve or decline. This proposal does not change the order yet.</p>
            <label className={styles.field}>Item to replace<select required value={originalProductId} onChange={(event) => setOriginalProductId(event.target.value)}>{order.items.map((item) => <option key={item.product_id} value={item.product_id}>{item.name} ({quantityText(item)})</option>)}</select></label>
            <label className={styles.field}>Replacement product<select required value={replacementProductId} onChange={(event) => setReplacementProductId(event.target.value)}><option value="">Choose a product</option>{selectableProducts.map((item) => <option key={item.id} value={item.id}>{item.name} · stock {item.stock} · {money(item.selling_price)}</option>)}</select></label>
            <label className={styles.field}>Quantity<input required type="number" min="0.001" step="0.001" value={substitutionQuantity} onChange={(event) => setSubstitutionQuantity(event.target.value)} /></label>
            <label className={styles.field}>Message to customer<textarea value={substitutionNote} onChange={(event) => setSubstitutionNote(event.target.value)} rows={2} placeholder="Why this replacement is suggested" /></label>
            {substitutionError && <p className={styles.errorText} role="alert">{substitutionError}</p>}
            <div className={styles.reviewActions}><button type="button" className="button button-secondary" disabled={substitutionBusy} onClick={() => setSubstitutionOpen(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={substitutionBusy || !replacementProductId}>{substitutionBusy ? "Sending…" : "Send proposal for consent"}</button></div>
          </form>}

          <section className={styles.thread} aria-labelledby="thread-title">
            <div className={styles.sectionHeading}><div><h3 id="thread-title">Customer messages</h3><p>Written replies stay in the thread.</p></div><MessageCircle size={20} /></div>
            <div className={styles.messages} role="log" aria-label="Order message thread" aria-live="polite" aria-relevant="additions">
              {order.messages.length === 0 && <p className={styles.empty}>No messages yet. Send a written reply or record one and review the transcript before sending.</p>}
              {order.messages.map((message) => <article key={message.id} className={`${styles.message} ${message.sender === "shopkeeper" ? styles.shopkeeperMessage : ""}`}>
                <div className={styles.messageMeta}><strong>{message.sender === "customer" ? (order.customer_name || "Customer") : "You"}</strong><span>{message.language} · {dateTime(message.created_at)}</span></div>
                <p>{message.text}</p>
                {translations[message.id] && <div className={styles.translated}><strong>Translation ({translations[message.id].language})</strong><p>{translations[message.id].text}</p><button type="button" className={styles.smallButton} onClick={() => void speak(translations[message.id].text, translations[message.id].language)}><Volume2 size={15} /> Read translation aloud</button></div>}
                <div className={styles.messageTools}>
                  <button type="button" className={styles.smallButton} onClick={() => void speak(message.text, message.language)}><Volume2 size={15} /> Read aloud</button>
                  <button type="button" className={styles.smallButton} onClick={() => void translateMessage(message)}><Languages size={15} /> Translate</button>
                </div>
              </article>)}
            </div>
            <div className={styles.translationControls}>
              <label>To<select aria-label="Translate message to" value={translationTarget} onChange={(event) => setTranslationTarget(event.target.value as Language)}>{LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
            </div>
            <form className={styles.composer} onSubmit={(event) => void sendMessage(event)}>
              <label className={styles.field}>Reply language<select value={messageLanguage} onChange={(event) => setMessageLanguage(event.target.value as Language)}>{LANGUAGES.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
              <label className={styles.field} htmlFor="customer-reply">Written reply</label>
              <textarea id="customer-reply" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} rows={3} placeholder="Write a reply to the customer…" />
              <div className={styles.composerActions}>
                <button type="button" className="button button-secondary" disabled={recording || transcribing} onClick={() => void beginRecording()}><Mic size={16} /> Record reply</button>
                {recording && <button type="button" className="button button-secondary" onClick={() => recorder.current?.stop()}>Stop recording</button>}
                <button type="submit" className="button button-primary" disabled={messageBusy || transcribing || !messageDraft.trim()}><Send size={16} />{messageBusy ? "Sending…" : "Send reply"}</button>
              </div>
              {recording && <p className={styles.subtle} role="status">Recording your reply. Stop to transcribe; review and edit it before sending.</p>}
              {transcribing && <p className={styles.subtle} role="status">Transcribing. Your reply will remain an editable draft.</p>}
              {messageError && <p className={styles.errorText} role="alert">{messageError}</p>}
              {voiceError && <p className={styles.errorText} role="alert">{voiceError}</p>}
            </form>
            {audioUrl && <div className={styles.audio}><audio ref={audio} controls src={audioUrl} aria-label="Message audio playback" /></div>}
          </section>
          <details className={styles.history}><summary>Order status history</summary>{order.events.length ? <ul>{order.events.map((event) => <li key={event.id}><strong>{STATUS_LABEL[event.status as OrderStatus] || event.status}</strong> · {dateTime(event.created_at)}{event.note ? ` — ${event.note}` : ""}</li>)}</ul> : <p>No status changes recorded.</p>}</details>
          {order.sale_id && <p className={styles.info}>Linked sale recorded: {order.sale_id}</p>}
          <p className={styles.updated}>Last updated {dateTime(order.updated_at)} · Revision {order.revision}</p>
        </>}
      </section>
    </div>
  </section>;
}
