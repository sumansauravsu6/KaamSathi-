"use client";

import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bell, Boxes, Check,
  CheckCircle2, ChevronRight, CircleDollarSign, Clock3, CreditCard, FileText,
  Headphones, Languages, LayoutDashboard, LogOut, Mic, Package, Pause, Play,
  Plus, Search, Send, Settings2, ShoppingBag, ShoppingCart, Sparkles, Store,
  TrendingUp, Users, Wallet, X,
} from "lucide-react";
import {
  FormEvent, ReactNode, useCallback, useEffect, useRef, useState,
} from "react";
import { flushSync } from "react-dom";
import Translator from "./translator";
import CustomerOrders from "./customer-orders";
import CustomerEntry from "./customer-entry";
import LocalAuthVoice from "./local-auth-voice";
import { useVoiceSession } from "./use-voice-session";
import { assistantSpeech, businessAudioAllowed, errorDetailMessage, normalizeSpokenIdentifier, pageDestination, playbackStopReason, waitForPlayback, workflowAction, type PageKey } from "./voice-helpers";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";
type Product = { id: string; name: string; category: string; unit: string; stock: string; min_stock: string; purchase_price: string; selling_price: string };
type Customer = { id: string; name: string; phone?: string; balance: string };
type Supplier = { id: string; name: string; phone?: string; balance: string };
type Sale = { id: string; total: string; payment_method: string; customer_id?: string; created_at: string };
type Expense = { id: string; category: string; amount: string; payment_method: string; notes: string; created_at: string };
type Summary = { sales: string; expenses: string; gross_profit: string; net_operating_earnings: string; sale_count: number; low_stock_count: number; customer_dues: string; supplier_dues: string; pending_customer_orders?: number; recent_activity: { action: string; created_at: string }[] };
type Reorder = { product_id: string; name: string; stock: string; min_stock: string; average_daily_sales: string; suggested_quantity: string; history_sufficient: boolean };
type Pending = { action_id: string; summary: string; confirmation_required: boolean };
type ChatMessage = { role: "user" | "assistant"; text: string };

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    throw new Error("Cannot connect to KaamSaathi. Check that the backend is running on port 8000.");
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
    throw new Error(errorDetailMessage(detail, `Something went wrong (${response.status}). Please try again.`));
  }
  if (response.headers.get("content-type")?.includes("application/json")) return response.json() as Promise<T>;
  return response as T;
}

function rupees(value: string | number | undefined) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}
function when(value?: string) {
  if (!value) return "Just now";
  const date = new Date(value);
  return date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}
function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

const navItems: { name: PageKey; icon: typeof LayoutDashboard }[] = [
  { name: "Dashboard", icon: LayoutDashboard },
  { name: "Voice assistant", icon: Mic },
  { name: "Translator", icon: Languages },
  { name: "Inventory", icon: Boxes },
  { name: "Sales", icon: ShoppingCart },
  { name: "Customers", icon: Users },
  { name: "Suppliers", icon: Store },
  { name: "Customer orders", icon: ShoppingBag },
  { name: "Expenses", icon: Wallet },
  { name: "Reports", icon: BarChart3 },
];
const quickActions: { label: string; icon: typeof Package; page: PageKey }[] = [
  { label: "Record a sale", icon: ShoppingCart, page: "Sales" },
  { label: "Add a product", icon: Package, page: "Inventory" },
  { label: "Collect udhaar", icon: CreditCard, page: "Customers" },
];

export default function Home() {
  const [sessionKey, setSessionKey] = useState(0);
  const [customerShop, setCustomerShop] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [modeError, setModeError] = useState("");
  useEffect(() => {
    try { setCustomerShop(localStorage.getItem("kaamsaathi-customer-shop")); }
    catch { setModeError("Device storage is unavailable. Your chosen mode cannot be remembered."); }
    setReady(true);
  }, []);
  function chooseMode(id: string | null) {
    try {
      if (id === null) localStorage.removeItem("kaamsaathi-customer-shop");
      else localStorage.setItem("kaamsaathi-customer-shop", id);
    } catch { setModeError("Your mode could not be saved. You can continue while this app stays open."); }
    setCustomerShop(id);
    setSessionKey((current) => current + 1);
  }
  if (!ready) return <p role="status">Loading KaamSaathi...</p>;
  return <>{modeError && <p role="alert">{modeError}</p>}{customerShop !== null
    ? <CustomerEntry shopId={customerShop} onChooseShop={chooseMode} onMerchant={() => chooseMode(null)} />
    : <AppSession key={sessionKey} onCustomerShopping={(id = "") => chooseMode(id)} onSignOut={() => setSessionKey((current) => current + 1)} />}</>;
}

function AppSession({ onSignOut, onCustomerShopping }: { onSignOut: () => void; onCustomerShopping: (shopId?: string) => void }) {
  const [token, setToken] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [registering, setRegistering] = useState(false);
  const [shopName, setShopName] = useState("");
  const [loadingLogin, setLoadingLogin] = useState(false);
  const [page, setPageState] = useState<PageKey>("Dashboard");
  const [shop, setShop] = useState<{ id: string; name: string; address: string; language: string; language_configured: boolean; is_demo?: boolean } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [weekly, setWeekly] = useState<Record<string, string> | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [reorder, setReorder] = useState<Reorder[]>([]);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatText, setChatText] = useState("");
  const [transcript, setTranscript] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [businessPending, setBusinessPending] = useState<Pending | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [assistantState, setAssistantState] = useState("Idle");
  const [listening, setListening] = useState(false);
  const [processingAudio, setProcessingAudio] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const [language, setLanguage] = useState("hi-IN");
  const [onboardingLanguage, setOnboardingLanguage] = useState("hi-IN");
  const [languageSaving, setLanguageSaving] = useState(false);
  const [companionOpen, setCompanionOpen] = useState(false);
  const [showProductForm, setShowProductForm] = useState(false);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showSaleForm, setShowSaleForm] = useState(false);
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [payCustomerId, setPayCustomerId] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [paySupplierId, setPaySupplierId] = useState("");
  const [paySupplierAmount, setPaySupplierAmount] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const authStops = useRef<Record<string, () => void>>({});
  const assistantLock = useRef(false);
  const recordingGeneration = useRef(0);
  const audioBusy = useRef(false);
  const sessionGeneration = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  function setPage(next: PageKey) {
    pageRef.current = next;
    setPageState(next);
  }
  function inTranslator() { return !businessAudioAllowed(pageRef.current); }
  const voiceSession = useVoiceSession(async (audio, signal) => {
    try {
      const form = new FormData();
      form.append("file", audio, audio.type.includes("mp4") ? "recording.mp4" : "recording.webm");
      form.append("mode", "transcribe");
      form.append("language", language);
      const result = await request<{ transcript: string }>("/api/voice/transcribe", token, { method: "POST", body: form, signal });
      if (signal.aborted) return "";
      if (!result.transcript.trim()) throw new Error("No speech was recognised. Start again or type.");
      return await sendAssistant(result.transcript, signal);
    } catch (error) {
      if (signal.aborted) return "";
      return error instanceof Error ? error.message : "Transcription failed.";
    }
  });

  function stopAuthVoice() { Object.values(authStops.current).forEach((stop) => stop()); }

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3800);
  }, []);

  const loadData = useCallback(async (auth: string) => {
    const session = sessionGeneration.current;
    const [shopData, dashboard, weeklyData, productData, customerData, supplierData, saleData, expenseData, reorderData] = await Promise.all([
      request<typeof shop>("/api/shop", auth),
      request<Summary>("/api/dashboard/summary", auth),
      request<Record<string, string>>("/api/reports/weekly", auth),
      request<Product[]>("/api/products", auth),
      request<Customer[]>("/api/customers", auth),
      request<Supplier[]>("/api/suppliers", auth),
      request<Sale[]>("/api/sales", auth),
      request<Expense[]>("/api/expenses", auth),
      request<Reorder[]>("/api/reports/reorder-suggestions", auth),
    ]);
    if (session !== sessionGeneration.current) return;
    setShop(shopData);
    setLanguage(shopData?.language || "hi-IN");
    setOnboardingLanguage(shopData?.language || "hi-IN");
    setSummary(dashboard);
    setWeekly(weeklyData);
    setProducts(productData);
    setCustomers(customerData);
    setSuppliers(supplierData);
    setSales(saleData);
    setExpenses(expenseData);
    setReorder(reorderData);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("kaamsaathi-token");
    const session = sessionGeneration.current;
    if (saved) {
      setToken(saved);
      loadData(saved).catch(() => {
        if (session !== sessionGeneration.current) return;
        window.localStorage.removeItem("kaamsaathi-token");
        setToken("");
      });
    }
  }, [loadData]);

  useEffect(() => {
    if (page === "Translator") {
      voiceSession.stop();
      audioRef.current?.pause();
      setAudioUrl("");
      recordingGeneration.current++;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setListening(false);
      audioBusy.current = false;
      setProcessingAudio(false);
    }
  // Stop capture whenever translation is entered; customer audio never reaches the business assistant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => () => {
    recordingGeneration.current++;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function signIn(demo: boolean, event?: FormEvent) {
    event?.preventDefault();
    stopAuthVoice();
    const session = sessionGeneration.current;
    setLoadingLogin(true);
    try {
      const data = demo
        ? await request<{ access_token: string; shop: { id: string; name: string } }>("/api/auth/demo", "", { method: "POST" })
        : registering
          ? await request<{ access_token: string; shop: { id: string; name: string } }>("/api/auth/register", "", {
            method: "POST", body: JSON.stringify({ ...(identifier.includes("@") ? { email: identifier.trim() } : { phone: identifier.trim() }), password, shop_name: shopName }),
          })
          : await request<{ access_token: string; shop: { id: string; name: string } }>("/api/auth/login", "", {
            method: "POST", body: JSON.stringify({ identifier: identifier.trim(), password }),
          });
      if (session !== sessionGeneration.current) return;
      window.localStorage.setItem("kaamsaathi-token", data.access_token);
      setToken(data.access_token);
      await loadData(data.access_token);
      setPassword("");
    } catch (error) {
      if (session !== sessionGeneration.current) return;
      window.localStorage.removeItem("kaamsaathi-token");
      setToken("");
      notify(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setLoadingLogin(false);
    }
  }

  async function refresh() {
    if (token) await loadData(token);
  }

  async function submitProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      await request("/api/products", token, { method: "POST", body: JSON.stringify({
        name: form.get("name"), category: form.get("category") || "General", unit: form.get("unit") || "pcs",
        purchase_price: form.get("purchase_price"), selling_price: form.get("selling_price"),
        stock: form.get("stock"), min_stock: form.get("min_stock"),
      }) });
      formElement.reset();
      setShowProductForm(false);
      notify("Product added to your inventory.");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Product could not be added."); }
    finally { setBusy(false); }
  }

  async function submitCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      await request("/api/customers", token, { method: "POST", body: JSON.stringify({ name: form.get("name"), phone: form.get("phone") || null }) });
      formElement.reset();
      setShowCustomerForm(false);
      notify("Customer added.");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Customer could not be added."); }
    finally { setBusy(false); }
  }

  async function submitSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      await request("/api/suppliers", token, { method: "POST", body: JSON.stringify({ name: form.get("name"), phone: form.get("phone") || null }) });
      formElement.reset();
      setShowSupplierForm(false);
      notify("Supplier added.");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Supplier could not be added."); }
    finally { setBusy(false); }
  }

  async function submitExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      const result = await request<Pending & { status: string }>("/api/expenses", token, { method: "POST", body: JSON.stringify({
        category: form.get("category"), amount: form.get("amount"),
        payment_method: form.get("payment_method"), notes: form.get("notes") || "", idempotency_key: newKey(),
      }) });
      formElement.reset();
      setShowExpenseForm(false);
      if (result.confirmation_required) setBusinessPending(result);
      else { notify("This expense has already been recorded."); await refresh(); }
    } catch (error) { notify(error instanceof Error ? error.message : "Expense could not be recorded."); }
    finally { setBusy(false); }
  }

  async function submitSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const productId = String(form.get("product_id") || "");
    const paymentMethod = String(form.get("payment_method") || "cash");
    const customerId = String(form.get("customer_id") || "");
    setBusy(true);
    try {
      const result = await request<Pending & { status: string }>("/api/sales", token, { method: "POST", body: JSON.stringify({
        items: [{ product_id: productId, quantity: form.get("quantity") }],
        payment_method: paymentMethod,
        customer_id: customerId || null,
        idempotency_key: newKey(),
      }) });
      formElement.reset();
      setShowSaleForm(false);
      if (result.confirmation_required) {
        setBusinessPending(result);
      } else {
        notify("This sale has already been recorded.");
        await refresh();
      }
    } catch (error) { notify(error instanceof Error ? error.message : "Sale could not be recorded."); }
    finally { setBusy(false); }
  }

  async function submitPayment(event: FormEvent) {
    event.preventDefault();
    if (!token || !payCustomerId) return;
    setBusy(true);
    try {
      const result = await request<Pending & { status: string; balance?: string }>(`/api/customers/${payCustomerId}/payments`, token, {
        method: "POST", body: JSON.stringify({ amount: payAmount, idempotency_key: newKey() }),
      });
      setPayCustomerId("");
      setPayAmount("");
      if (result.confirmation_required) setBusinessPending(result);
      else { notify(`This payment was already recorded. Balance: ${rupees(result.balance)}`); await refresh(); }
    } catch (error) { notify(error instanceof Error ? error.message : "Payment could not be recorded."); }
    finally { setBusy(false); }
  }

  async function submitPurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    try {
      const result = await request<Pending & { status: string }>("/api/purchases", token, {
        method: "POST",
        body: JSON.stringify({
          supplier_id: form.get("supplier_id"),
          items: [{ product_id: form.get("product_id"), quantity: form.get("quantity"), unit_price: form.get("unit_price") }],
          payment_method: form.get("payment_method"),
          idempotency_key: newKey(),
        }),
      });
      formElement.reset();
      setShowPurchaseForm(false);
      if (result.confirmation_required) setBusinessPending(result);
      else { notify("This purchase has already been recorded."); await refresh(); }
    } catch (error) { notify(error instanceof Error ? error.message : "Purchase could not be recorded."); }
    finally { setBusy(false); }
  }

  async function submitSupplierPayment(event: FormEvent) {
    event.preventDefault();
    if (!token || !paySupplierId) return;
    setBusy(true);
    try {
      const result = await request<Pending & { status: string; balance?: string }>(`/api/suppliers/${paySupplierId}/payments`, token, {
        method: "POST", body: JSON.stringify({ amount: paySupplierAmount, idempotency_key: newKey() }),
      });
      setPaySupplierId("");
      setPaySupplierAmount("");
      if (result.confirmation_required) setBusinessPending(result);
      else { notify(`Payment was already recorded. Balance: ${rupees(result.balance)}.`); await refresh(); }
    } catch (error) { notify(error instanceof Error ? error.message : "Supplier payment could not be recorded."); }
    finally { setBusy(false); }
  }

  async function updateLanguage(code: string) {
    if (languageSaving) return;
    setLanguageSaving(true);
    try {
      const result = await request<typeof shop>("/api/shop", token, { method: "PATCH", body: JSON.stringify({ language: code }) });
      setShop(result);
      setLanguage(code);
      notify("Preferred language updated.");
    } catch (error) { notify(error instanceof Error ? error.message : "Could not update language."); }
    finally { setLanguageSaving(false); }
  }

  async function sendAssistant(text = transcript || chatText, signal?: AbortSignal): Promise<string | null> {
    const clean = text.trim();
    if (!clean) return "Nothing to send. Speak again or type.";
    if (!token || busy || assistantLock.current || audioBusy.current) return "The assistant is busy. Try again when the current request finishes.";
    if (inTranslator()) return "Business assistant is off while the translator is open.";
    const session = sessionGeneration.current;
    assistantLock.current = true;
    setBusy(true);
    setAssistantState("Understanding request");
    setMessages((old) => [...old, { role: "user", text: clean }]);
    setTranscript("");
    setChatText("");
    try {
      const result = await request<{
        text: string; conversation_id: string; pending_action: Pending | null;
        destination?: unknown; ui_action?: unknown; clarification_required?: boolean; confirmation_prompt?: boolean;
      }>("/api/assistant/respond", token, {
        method: "POST", body: JSON.stringify({ message: clean, language, conversation_id: conversationId || null }),
      });
      if (session !== sessionGeneration.current) return "";
      setConversationId(result.conversation_id);
      setPending(result.pending_action);
      setMessages((old) => [...old, { role: "assistant", text: result.text }]);
      const destination = pageDestination(result.destination);
      if (!inTranslator() && destination) {
        setPage(destination);
        setSearch("");
        setCompanionOpen(destination !== "Translator");
        if (workflowAction(destination, result.ui_action) === "add_supplier") setShowSupplierForm(true);
        else if (destination === "Suppliers" && result.pending_action && result.confirmation_prompt) setShowSupplierForm(false);
      }
      const responseState = result.pending_action && result.confirmation_prompt ? "Waiting for confirmation"
        : result.clarification_required ? "Waiting for clarification" : "Completed";
      setAssistantState(responseState);
      if (inTranslator()) {
        try { await refresh(); } catch { notify("Response received, but the dashboard could not refresh."); }
        return "";
      }
      const playbackFailure = await speakResponse(assistantSpeech(result.text, result.pending_action, result.confirmation_prompt), signal);
      if (session !== sessionGeneration.current) return "";
      setAssistantState(responseState);
      if (session === sessionGeneration.current) {
        try { await refresh(); } catch { notify("Response received, but the dashboard could not refresh."); }
      }
      return playbackFailure;
    } catch (error) {
      if (session !== sessionGeneration.current) return "";
      const message = error instanceof Error ? error.message : "The assistant could not process that request.";
      setMessages((old) => [...old, { role: "assistant", text: message }]);
      setAssistantState("Error");
      return message;
    } finally { assistantLock.current = false; setBusy(false); }
  }

  async function speakResponse(text: string, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted || inTranslator()) return "";
    if (!token || !text) return "There was no reply to speak.";
    if (text.length > 1200) return "The reply is too long to speak. Read it above, then start again.";
    const session = sessionGeneration.current;
    try {
      const response = await request<Response>("/api/voice/speak", token, {
        method: "POST", body: JSON.stringify({ text, language }), signal,
      });
      const blob = await response.blob();
      if (session !== sessionGeneration.current || signal?.aborted || inTranslator()) return "";
      const url = URL.createObjectURL(blob);
      flushSync(() => setAudioUrl(url));
      const element = audioRef.current;
      if (inTranslator()) { element?.pause(); return ""; }
      if (!element) throw new Error("Audio controls are unavailable.");
      const playback = await waitForPlayback(element, signal);
      const reason = playbackStopReason(playback);
      if (reason) notify(reason);
      return playback.ok ? null : reason;
    } catch (error) {
      if (session !== sessionGeneration.current || signal?.aborted) return "";
      const message = error instanceof Error ? `Text is ready, but voice playback is unavailable: ${error.message}` : "Text is ready; voice playback is unavailable.";
      notify(message);
      return message;
    }
  }

  async function resolvePending(confirmed: boolean) {
    if (!token || !pending || assistantLock.current) return;
    const session = sessionGeneration.current;
    assistantLock.current = true;
    setBusy(true);
    setAssistantState("Executing operation");
    try {
      const result = await request<{ status: string; result?: { total?: string; balance?: string; amount?: string } }>("/api/assistant/confirm", token, {
        method: "POST", body: JSON.stringify({ action_id: pending.action_id, confirmed }),
      });
      if (session !== sessionGeneration.current) return;
      setPending(null);
      if (confirmed) {
        const detail = result.result?.total
          ? `Sale recorded for ${rupees(result.result.total)}.`
          : result.result?.balance
            ? `Payment recorded. New balance is ${rupees(result.result.balance)}.`
            : result.result?.amount ? `Expense recorded for ${rupees(result.result.amount)}.` : "Done. Your records have been updated.";
        setMessages((old) => [...old, { role: "assistant", text: detail }]);
        setAssistantState("Completed");
        await speakResponse(detail);
        if (session !== sessionGeneration.current) return;
        notify(detail);
      } else {
        setMessages((old) => [...old, { role: "assistant", text: "Cancelled. Nothing was changed." }]);
        setAssistantState("Idle");
      }
      await refresh();
    } catch (error) {
      if (session !== sessionGeneration.current) return;
      const message = error instanceof Error ? error.message : "This action could not be completed.";
      notify(message);
      setAssistantState("Error");
    } finally { assistantLock.current = false; setBusy(false); }
  }

  async function resolveBusinessPending(confirmed: boolean) {
    if (!token || !businessPending) return;
    const session = sessionGeneration.current;
    setBusy(true);
    try {
      const result = await request<{ status: string; result?: { total?: string; amount?: string; balance?: string } }>("/api/assistant/confirm", token, {
        method: "POST", body: JSON.stringify({ action_id: businessPending.action_id, confirmed }),
      });
      if (session !== sessionGeneration.current) return;
      setBusinessPending(null);
      if (!confirmed) notify("Cancelled. Nothing was changed.");
      else {
        const detail = result.result?.total ? `Sale recorded for ${rupees(result.result.total)}.`
          : result.result?.amount ? `Expense recorded for ${rupees(result.result.amount)}.`
            : result.result?.balance ? `Payment recorded. New balance is ${rupees(result.result.balance)}.`
              : "Done. Your records have been updated.";
        notify(detail);
      }
      await refresh();
    } catch (error) {
      if (session !== sessionGeneration.current) return;
      notify(error instanceof Error ? error.message : "This action could not be completed.");
    } finally { setBusy(false); }
  }

  async function startRecording() {
    if (!token || listening || busy || audioBusy.current || page === "Translator") return;
    audioBusy.current = true;
    const generation = ++recordingGeneration.current;
    audioRef.current?.pause();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      audioBusy.current = false;
      notify("Audio recording is not supported in this browser. You can type your request instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== recordingGeneration.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        recordingGeneration.current++;
        audioBusy.current = false;
        stream.getTracks().forEach((track) => track.stop());
        setListening(false);
        setAssistantState("Error");
        notify("Recording failed. Please retry or type your request.");
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (generation !== recordingGeneration.current) return;
        setListening(false);
        setAssistantState("Processing audio");
        setProcessingAudio(true);
        const audio = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (!audio.size) {
          audioBusy.current = false;
          setProcessingAudio(false);
          setAssistantState("Error");
          notify("No audio was captured. Please try recording again.");
          return;
        }
        try {
          const form = new FormData();
          form.append("file", audio, recorder.mimeType.includes("mp4") ? "recording.mp4" : "recording.webm");
          form.append("mode", "transcribe");
          form.append("language", language);
          const result = await request<{ transcript: string }>("/api/voice/transcribe", token, { method: "POST", body: form });
          if (generation !== recordingGeneration.current) return;
          if (!result.transcript.trim()) throw new Error("No speech was recognised. Please try again or type.");
          audioBusy.current = false;
          setProcessingAudio(false);
          setTranscript(result.transcript);
          setAssistantState("Check what I heard");
        } catch (error) {
          if (generation !== recordingGeneration.current) return;
          audioBusy.current = false;
          setProcessingAudio(false);
          setAssistantState("Error");
          notify(error instanceof Error ? error.message : "We could not transcribe that recording.");
        }
      };
      recorder.start();
      setListening(true);
      setAssistantState("Listening");
      window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 30_000);
    } catch {
      audioBusy.current = false;
      notify("Microphone access was not granted. Please allow microphone access or type your request.");
      setAssistantState("Error");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  function signOut() {
    voiceSession.stop();
    sessionGeneration.current++;
    recordingGeneration.current++;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    audioRef.current?.pause();
    setAudioUrl("");
    window.localStorage.removeItem("kaamsaathi-token");
    setToken("");
    setShop(null);
    setMessages([]);
    setPending(null);
    setBusinessPending(null);
    setConversationId("");
    setTranscript("");
    setChatText("");
    setListening(false);
    setProcessingAudio(false);
    audioBusy.current = false;
    setCompanionOpen(false);
    setPage("Dashboard");
    onSignOut();
  }

  function handOverToCustomer() {
    if (!shop || !window.confirm("Lock shopkeeper access and start a fresh customer session? Saved customer access on this shared device will be removed. Returning to business records will require signing in again.")) return;
    const shopId = shop.id;
    try { localStorage.removeItem(`kaamsaathi-shopping:${shopId}`); }
    catch { notify("Could not clear previous customer access. Handover cancelled to protect their privacy."); return; }
    stopAuthVoice();
    signOut();
    onCustomerShopping(shopId);
  }

  const filteredProducts = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
  const filteredCustomers = customers.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));
  const filteredSuppliers = suppliers.filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
  const filteredSales = sales.filter((s) => s.payment_method.toLowerCase().includes(search.toLowerCase()));
  const filteredExpenses = expenses.filter((item) => item.category.toLowerCase().includes(search.toLowerCase()));

  if (!token) {
    return (
      <>
        <main className="login-page">
          <section className="login-visual">
            <div className="brand"><div className="brand-mark"><Store size={20} /></div><div><div className="brand-name">KaamSaathi</div><div className="brand-tag" style={{ color: "#c5dbca" }}>YOUR SHOP. YOUR LANGUAGE. JUST SPEAK.</div></div></div>
            <div className="login-hero">
              <div className="eyebrow" style={{ color: "#b9d8c2" }}>MADE FOR YOUR EVERYDAY</div>
              <h1>Your shop,<br />running a little<br />smoother.</h1>
              <p>Keep track of stock, sales and udhaar. Or simply ask your Saathi — in your language.</p>
            </div>
            <div className="login-foot">A friendly business companion for neighbourhood shops.</div>
          </section>
          <section className="login-form-area">
            <section className="customer-mode-entry" aria-labelledby="customer-mode-title">
              <h2 id="customer-mode-title">Here to shop?</h2>
              <p>No account, QR code or speaking needed.</p>
              <button type="button" className="button button-primary" onClick={() => { stopAuthVoice(); onCustomerShopping(); }}>Shop as customer</button>
            </section>
            <form className="login-card" onSubmit={(event) => signIn(false, event)}>
              <h2>{registering ? "Set up your shop" : "Welcome back"}</h2>
              <p>{registering ? "Create your account and get your shop ready." : "Sign in to pick up where you left off."}</p>
              {registering && <><label className="field">Shop name<input required minLength={1} maxLength={160} placeholder="e.g. Apna Kirana" value={shopName} onChange={(e) => setShopName(e.target.value)} /></label>
                <LocalAuthVoice onText={setShopName} onBeforeStart={stopAuthVoice} registerStop={(stop) => { authStops.current.shop = stop; }} /></>}
              <label className="field">Email address or phone number<input required type="text" autoComplete="username" placeholder="Email or phone" value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></label>
              <LocalAuthVoice onText={(text) => setIdentifier(normalizeSpokenIdentifier(text))} onBeforeStart={stopAuthVoice} registerStop={(stop) => { authStops.current.identifier = stop; }} />
              <label className="field">Password<input required minLength={registering ? 8 : undefined} type="password" autoComplete={registering ? "new-password" : "current-password"} onFocus={stopAuthVoice} placeholder={registering ? "At least 8 characters" : "Your password"} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <p className="panel-note">Type or autofill your password. Never speak it: others or a microphone could overhear.</p>
              <button className="button button-primary" disabled={loadingLogin}>{loadingLogin ? "One moment..." : registering ? "Create your account" : "Sign in to your shop"}</button>
              <button type="button" className="text-link" style={{ width: "100%", marginTop: 13 }} onClick={() => { stopAuthVoice(); setRegistering(!registering); }}>{registering ? "Already have an account? Sign in" : "New to KaamSaathi? Set up your shop"}</button>
              <div className="login-divider">OR TRY THE DEMO</div>
              <div className="demo-note">A ready-to-explore shop with sample stock, customers and activity.<br />No setup needed — your demo data is kept separate.</div>
              <button type="button" className="button button-secondary" disabled={loadingLogin} onClick={() => signIn(true)} style={{ marginTop: 13 }}>
                <Store size={15} /> {loadingLogin ? "Opening demo..." : "Explore demo shop"}
              </button>
            </form>
          </section>
        </main>
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  const chartDates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return date;
  });
  const dailySales = chartDates.map((date) => sales
    .filter((sale) => new Date(sale.created_at).toDateString() === date.toDateString())
    .reduce((sum, sale) => sum + Number(sale.total), 0));
  const chartMax = Math.max(...dailySales, 1);
  const todaySales = summary?.sales || "0";
  const recentSales = sales.slice(0, 5);
  const initial = (shop?.name || "A").slice(0, 1).toUpperCase();

  function heading(title: string, subtitle: string, action?: ReactNode) {
    return <div className="page-heading"><div><div className="eyebrow">YOUR BUSINESS, AT A GLANCE</div><h1>{title}</h1><p className="subtitle">{subtitle}</p></div>{action}</div>;
  }

  function productTable(rows: Product[], editable = false) {
    return rows.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Product</th><th>In stock</th><th>Buying price</th><th>Selling price</th><th>Status</th>{editable && <th>Quick update</th>}</tr></thead><tbody>{rows.map((p) => (
      <tr key={p.id}><td><div className="product-name"><span className="product-thumb"><Package size={16} /></span><span>{p.name}<small className="muted" style={{ display: "block", fontSize: 10, fontWeight: 400, marginTop: 3 }}>{p.category}</small></span></div></td>
        <td><strong>{Number(p.stock)} {p.unit}</strong></td><td>{rupees(p.purchase_price)}</td><td>{rupees(p.selling_price)}</td>
        <td><span className={`badge ${Number(p.stock) <= Number(p.min_stock) ? "badge-low" : "badge-ok"}`}>{Number(p.stock) <= Number(p.min_stock) ? "Low stock" : "In stock"}</span></td>
        {editable && <td><div className="inline-actions"><button title="Add one to stock" className="icon-button" onClick={() => updateStock(p, 1)}><Plus size={14} /></button><button title="Remove one from stock" className="icon-button" onClick={() => updateStock(p, -1)}><X size={14} /></button></div></td>}
      </tr>
    ))}</tbody></table></div> : <div className="empty-state">No products match. Add your first product above.</div>;
  }

  async function updateStock(product: Product, delta: number) {
    const next = Number(product.stock) + delta;
    if (next < 0) return notify("Stock cannot go below zero.");
    try {
      await request(`/api/products/${product.id}`, token, { method: "PATCH", body: JSON.stringify({ stock: next }) });
      notify(`${product.name} stock updated.`);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "Stock update failed."); }
  }

  function assistantPanel() {
    return <div className="assistant-layout">
      <div>
        <section className="voice-card">
          <div className="voice-content">
            <button type="button" aria-label={listening ? "Finish recording" : voiceSession.active ? "Send now" : "Start conversation"} className={`voice-mic ${listening || voiceSession.listening ? "listening" : ""}`} onClick={listening ? stopRecording : voiceSession.active ? voiceSession.finishTurn : () => { audioRef.current?.pause(); void voiceSession.start(); }} disabled={(busy || processingAudio || (voiceSession.active && !voiceSession.listening)) && !listening}>
              {listening || voiceSession.listening ? <Send size={26} /> : <Mic size={27} />}
            </button>
            <div className="voice-title">{listening || voiceSession.listening ? "I'm listening…" : voiceSession.active || processingAudio ? "A moment, please" : "Tell me what you need"}</div>
            <div className="voice-sub">{listening ? "Tap Send to finish. Check the words before sending." : voiceSession.listening ? "Send now, or pause for 3 seconds. Up to 30 seconds per turn." : voiceSession.active ? "I'll listen again after the reply." : "Tap once. Speak, hear the reply, and keep going."}</div>
            <div className="voice-tip"><Sparkles size={13} /> You can say “No, the name is Anmol Tea”</div>
            {voiceSession.active ? <button type="button" className="button button-secondary" style={{ marginTop: 16 }} onClick={() => voiceSession.stop()}>Stop conversation</button>
              : !listening && <button type="button" className="button button-secondary" style={{ marginTop: 16 }} disabled={busy || processingAudio} onClick={() => void startRecording()}>Record & review instead</button>}
            {voiceSession.status && <div className="voice-sub" role="status">{voiceSession.status}</div>}
          </div>
        </section>
        <div className="status-line"><span className={`dot ${listening || voiceSession.listening || busy ? "live" : ""}`} />{voiceSession.listening ? "Listening" : assistantState}{listening && " · max 30 seconds"}</div>
        {transcript && <div className="transcript-box">
          <div className="transcript-label">Heard you — edit before sending</div>
          <textarea className="transcript-input" value={transcript} onChange={(e) => setTranscript(e.target.value)} />
          <div className="form-actions"><button className="button button-secondary" onClick={() => setTranscript("")}>Discard</button><button className="button button-primary" disabled={busy || voiceSession.active || listening || processingAudio} onClick={() => sendAssistant(transcript)}><Send size={14} /> Send to Saathi</button></div>
        </div>}
      </div>
      <section className="panel chat-panel">
        <div className="panel-heading"><div><h2 className="panel-title">Your Saathi</h2><div className="panel-note">Ask about stock, sales, customers or payments</div></div><Sparkles size={16} color="#176444" /></div>
        <div className="chat-messages">
          {messages.length === 0 && <div className="empty-state"><div style={{ color: "var(--green)", marginBottom: 8 }}><Headphones size={27} /></div>Go ahead — ask about your shop, or try a quick example.<div style={{ marginTop: 14, display: "grid", gap: 7 }}><button className="text-link" onClick={() => setChatText("How many Maggi packets are in stock?")}>“How many Maggi packets are in stock?”</button><button className="text-link" onClick={() => setChatText("How much does Ravi owe?")}>“How much does Ravi owe?”</button></div></div>}
          {messages.map((message, index) => <div key={`${index}-${message.role}`} className={`message ${message.role === "user" ? "user" : ""}`}>{message.text}</div>)}
          {pending && <div className="confirm-box"><div className="confirm-title"><AlertTriangle size={15} /> Please confirm this change</div><div className="confirm-summary">{pending.summary}</div><div className="panel-note">Say yes or no, or use these buttons.</div><div className="confirm-actions"><button className="button button-secondary" disabled={busy} onClick={() => { voiceSession.stop(); void resolvePending(false); }}><X size={13} /> No, cancel</button><button className="button button-primary" disabled={busy} onClick={() => { voiceSession.stop(); void resolvePending(true); }}><Check size={14} /> Yes, confirm</button></div></div>}
          {busy && <div className="message"><span className="dot live" style={{ display: "inline-block", marginRight: 8 }} />Working on that…</div>}
        </div>
        <div hidden={!audioUrl || voiceSession.active} style={{ marginBottom: 10 }}><audio ref={audioRef} controls src={audioUrl || undefined} style={{ width: "100%", height: 36 }} /></div>
        <div id="assistant-compose-status" className="panel-note" role="status">{busy ? "Saathi is replying. Typing is available when the reply finishes." : voiceSession.active ? "Voice conversation is on. Stop it to type." : listening || processingAudio ? "Listening or processing audio. Typing is paused." : ""}</div>
        <form className="chat-compose" onSubmit={(event) => { event.preventDefault(); void sendAssistant(chatText); }}>
          <input placeholder="Type a message to Saathi…" aria-describedby="assistant-compose-status" disabled={busy || voiceSession.active || processingAudio || listening} value={chatText} onChange={(event) => setChatText(event.target.value)} />
          <button type="submit" className="round-button" aria-label="Send message" disabled={busy || voiceSession.active || processingAudio || listening || !chatText.trim()}><Send size={15} /></button>
        </form>
      </section>
    </div>;
  }

  function productForm() {
    return showProductForm && <form className="form-card" onSubmit={submitProduct}>
      <div className="panel-heading"><div><h2 className="panel-title">Add a product</h2><div className="panel-note">Set your stock, buying price and selling price</div></div><button type="button" className="icon-button" onClick={() => setShowProductForm(false)}><X size={15} /></button></div>
      <div className="form-grid">
        <label className="field">Product name<input name="name" required placeholder="e.g. Maggi" /></label>
        <label className="field">Category<input name="category" placeholder="e.g. Snacks" /></label>
        <label className="field">Unit<input name="unit" placeholder="packets" defaultValue="pcs" /></label>
        <label className="field">Buying price (₹)<input name="purchase_price" required type="number" step="0.01" min="0" placeholder="12" /></label>
        <label className="field">Selling price (₹)<input name="selling_price" required type="number" step="0.01" min="0" placeholder="15" /></label>
        <label className="field">Opening stock<input name="stock" required type="number" step="0.001" min="0" placeholder="20" /></label>
        <label className="field">Low-stock alert at<input name="min_stock" required type="number" step="0.001" min="0" defaultValue="5" /></label>
      </div><div className="form-actions"><button disabled={busy} className="button button-primary"><Plus size={14} /> Save product</button></div>
    </form>;
  }

  function customerForm() {
    return showCustomerForm && <form className="form-card" onSubmit={submitCustomer}>
      <div className="panel-heading"><h2 className="panel-title">Add a customer</h2><button type="button" className="icon-button" onClick={() => setShowCustomerForm(false)}><X size={15} /></button></div>
      <div className="form-grid"><label className="field">Customer name<input name="name" required placeholder="e.g. Ravi" /></label><label className="field">Phone number (optional)<input name="phone" type="tel" placeholder="Mobile number" /></label></div>
      <div className="form-actions"><button disabled={busy} className="button button-primary"><Plus size={14} /> Save customer</button></div>
    </form>;
  }

  const body = (() => {
    if (page === "Translator") return <Translator token={token} preferredLanguage={language} apiRequest={request} onExit={() => setPage("Voice assistant")} />;
    if (page === "Customer orders") return <CustomerOrders token={token} preferredLanguage={language} apiRequest={request} onStartShopping={handOverToCustomer} onRecordStart={() => {
      recordingGeneration.current++;
      voiceSession.stop();
      audioRef.current?.pause();
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      audioBusy.current = false;
      setListening(false);
      setProcessingAudio(false);
      setCompanionOpen(false);
    }} />;
    if (page === "Dashboard") return <>
      {heading(`Good morning, ${shop?.name || "shopkeeper"}`, "Here’s how your shop is doing today.", <button className="button button-primary" onClick={() => setPage("Voice assistant")}><Mic size={15} /> Talk to Saathi</button>)}
      {(summary?.low_stock_count || 0) > 0 && <div className="alert-strip"><AlertTriangle size={18} /><div className="alert-text"><strong>{summary?.low_stock_count} products need a look</strong><br />A few shelves are running low. Check your stock before the next rush.</div><button className="text-link" onClick={() => setPage("Inventory")}>See products <ChevronRight size={13} /></button></div>}
      <div className="stats-grid">
        <Stat icon={<CircleDollarSign size={17} />} color="green" label="Sales today" value={rupees(summary?.sales)} note={`${summary?.sale_count || 0} sales recorded today`} />
        <Stat icon={<Wallet size={16} />} color="orange" label="Expenses today" value={rupees(summary?.expenses)} note="Operating expenses only" />
        <Stat icon={<TrendingUp size={16} />} color="blue" label="Est. earnings" value={rupees(summary?.net_operating_earnings)} note="After recorded expenses" />
        <Stat icon={<Boxes size={16} />} color="purple" label="Low stock" value={String(summary?.low_stock_count || 0)} note="Products at or below minimum" />
      </div>
      <div className="stats-grid" style={{ marginTop: -7 }}>
        <Stat icon={<Users size={16} />} color="orange" label="Customer udhaar" value={rupees(summary?.customer_dues)} note="Pending customer balances" />
        <Stat icon={<Store size={16} />} color="blue" label="Supplier dues" value={rupees(summary?.supplier_dues)} note="Pending supplier balances" />
        <Stat icon={<TrendingUp size={16} />} color="green" label="Gross profit" value={rupees(summary?.gross_profit)} note="From itemised sales" />
        <Stat icon={<ShoppingBag size={16} />} color="purple" label="In your catalogue" value={String(products.length)} note="Active products" />
      </div>
      <section className="panel" style={{ marginBottom: 17 }}>
        <div className="panel-heading">
          <div><h2 className="panel-title">Accessible shopping</h2><div className="panel-note">Share your shop link and respond to customer orders and messages.</div></div>
          <button className="button button-primary" onClick={() => setPage("Customer orders")}>
            <ShoppingBag size={15} /> Customer orders{(summary?.pending_customer_orders || 0) > 0 ? ` · ${summary?.pending_customer_orders} new` : ""}
          </button>
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">This week at your shop</h2><div className="panel-note">A quick look at how you’re doing</div></div><button className="text-link" onClick={() => setPage("Reports")}>View reports <ChevronRight size={13} /></button></div>
          <div className="chart-area">{chartDates.map((date, i) => <div className="chart-col" key={date.toISOString()} title={`Sales: ${rupees(dailySales[i])}`}><div className={`chart-bar ${i === 6 ? "today" : ""}`} style={{ height: `${dailySales[i] ? Math.max(5, dailySales[i] / chartMax * 100) : 2}%` }} /><span>{i === 6 ? "Today" : date.toLocaleDateString("en-IN", { weekday: "short" })}</span></div>)}</div>
          <div style={{ display: "flex", gap: 18, marginTop: 14, color: "var(--muted)", fontSize: 10 }}><span><span style={{ color: "var(--green)", fontWeight: 800, marginRight: 5 }}>●</span>Recorded sales</span><span className="muted">Based on transaction history</span></div>
        </section>
        <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Recent activity</h2><div className="panel-note">The latest from your shop</div></div><Clock3 size={15} color="#91a097" /></div>
          <div className="activity-list">{recentSales.length ? recentSales.map((sale) => <div className="activity-row" key={sale.id}><div className="activity-dot"><ShoppingBag size={14} /></div><div className="activity-main">{sale.payment_method === "credit" ? "Credit sale" : "Sale recorded"}<div className="activity-time">{when(sale.created_at)} · {sale.payment_method.toUpperCase()}</div></div><div className="activity-amount">{rupees(sale.total)}</div></div>) : <div className="empty-state">Your sales will show up here.</div>}</div>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 17 }}><div className="panel-heading"><div><h2 className="panel-title">A few quick things</h2><div className="panel-note">Your regular tasks, one tap away</div></div></div>
        <div className="quick-grid">{quickActions.map(({ label, icon: Icon, page: targetPage }) => <button key={label} className="quick-card" onClick={() => { setPage(targetPage); if (targetPage === "Sales") setShowSaleForm(true); if (targetPage === "Inventory") setShowProductForm(true); if (targetPage === "Customers") setPayCustomerId(customers[0]?.id || ""); }}><span className="quick-icon"><Icon size={15} /></span><span>{label}</span><ChevronRight size={13} style={{ marginLeft: "auto", color: "#9ba69e" }} /></button>)}</div>
      </section>
    </>;

    if (page === "Voice assistant") return <>
      {heading("Talk to your Saathi", "Your shop speaks your language. Ask, and we’ll take it from there.", <span className="badge badge-ok"><Languages size={12} /> {language === "hi-IN" ? "हिन्दी" : language === "ta-IN" ? "தமிழ்" : "English"}</span>)}
    </>;

    if (page === "Inventory") return <>
      {heading("Your inventory", "Know what’s on the shelf and what needs topping up.", <button className="button button-primary" onClick={() => setShowProductForm(!showProductForm)}><Plus size={15} /> Add product</button>)}
      {productForm()}
      <section className="panel">
        <div className="panel-heading"><div><h2 className="panel-title">Products <span className="muted" style={{ fontWeight: 400 }}>({filteredProducts.length})</span></h2><div className="panel-note">Opening inventory is labelled demo data in the sample shop.</div></div><div className="search-box"><Search size={14} color="#89958c" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a product" /></div></div>
        {productTable(filteredProducts, true)}
      </section>
      <section className="panel" style={{ marginTop: 16 }}><div className="panel-heading"><div><h2 className="panel-title">Stock movement at a glance</h2><div className="panel-note">Suggestions are based on recorded sales from the last 30 days.</div></div></div>
        {reorder.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Product</th><th>Available</th><th>Suggested top-up</th><th>Sales history</th></tr></thead><tbody>{reorder.slice(0, 8).map((item) => <tr key={item.product_id}><td><strong>{item.name}</strong></td><td>{item.stock}</td><td>{item.suggested_quantity}</td><td>{item.history_sufficient ? "Based on recent sales" : "Not enough sales history"}</td></tr>)}</tbody></table></div> : <div className="empty-state">Your shelves are looking good.</div>}
      </section>
    </>;

    if (page === "Sales") return <>
      {heading("Sales & purchases", "Record the day’s sales and keep an eye on recent transactions.", <button className="button button-primary" onClick={() => setShowSaleForm(!showSaleForm)}><Plus size={15} /> Record a sale</button>)}
      {showSaleForm && <form className="form-card" onSubmit={submitSale}><div className="panel-heading"><div><h2 className="panel-title">Record a sale</h2><div className="panel-note">Stock and credit balances update together when you save.</div></div><button type="button" className="icon-button" onClick={() => setShowSaleForm(false)}><X size={15} /></button></div>
        <div className="form-grid"><label className="field">Product<select name="product_id" required defaultValue=""><option value="" disabled>Choose product</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} · {Number(p.stock)} {p.unit}</option>)}</select></label><label className="field">Quantity<input name="quantity" required type="number" min="0.001" step="0.001" placeholder="3" /></label><label className="field">Payment type<select name="payment_method" defaultValue="cash"><option value="cash">Cash</option><option value="upi">UPI</option><option value="credit">Udhaar / Credit</option></select></label><label className="field">Customer (for credit)<select name="customer_id" defaultValue=""><option value="">Select a customer</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
        <div className="form-actions"><button className="button button-primary" disabled={busy}><Check size={14} /> Confirm sale</button></div>
      </form>}
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Recent sales</h2><div className="panel-note">Each saved sale is reflected in stock and the customer ledger.</div></div><div className="search-box"><Search size={14} color="#89958c" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by payment" /></div></div>
        {filteredSales.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Sale</th><th>When</th><th>Payment</th><th>Amount</th><th>Details</th></tr></thead><tbody>{filteredSales.map((sale) => <tr key={sale.id}><td><strong>#{sale.id.slice(0, 7)}</strong></td><td>{new Date(sale.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td><td><span className={`badge ${sale.payment_method === "credit" ? "badge-credit" : "badge-ok"}`}>{sale.payment_method.toUpperCase()}</span></td><td><strong>{rupees(sale.total)}</strong></td><td>{sale.customer_id ? customers.find((c) => c.id === sale.customer_id)?.name || "Customer" : "Walk-in"}</td></tr>)}</tbody></table></div> : <div className="empty-state">No sales recorded yet.</div>}
      </section>
    </>;

    if (page === "Customers") return <>
      {heading("Customers & udhaar", "Keep customer balances clear, fair and up to date.", <button className="button button-primary" onClick={() => setShowCustomerForm(!showCustomerForm)}><Plus size={15} /> Add customer</button>)}
      {customerForm()}
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Your customers</h2><div className="panel-note">Balances are calculated from each customer’s ledger.</div></div><div className="search-box"><Search size={14} color="#89958c" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a customer" /></div></div>
        {filteredCustomers.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Customer</th><th>Phone</th><th>Outstanding balance</th><th>Record a payment</th></tr></thead><tbody>{filteredCustomers.map((c) => <tr key={c.id}><td><div className="product-name"><span className="product-thumb"><Users size={15} /></span>{c.name}</div></td><td>{c.phone || "—"}</td><td><strong>{rupees(c.balance)}</strong>{Number(c.balance) > 0 && <span className="badge badge-credit" style={{ marginLeft: 8 }}>Owes</span>}</td><td><button className="button button-secondary" style={{ minHeight: 32, padding: "0 9px" }} onClick={() => { setPayCustomerId(c.id); setPayAmount(""); }}><CircleDollarSign size={13} /> Receive payment</button></td></tr>)}</tbody></table></div> : <div className="empty-state">No customers found. Add one to start a ledger.</div>}
      </section>
      {payCustomerId && <form className="form-card" onSubmit={submitPayment} style={{ marginTop: 15 }}><div className="panel-heading"><div><h2 className="panel-title">Record customer payment</h2><div className="panel-note">From {customers.find((c) => c.id === payCustomerId)?.name}</div></div><button type="button" className="icon-button" onClick={() => setPayCustomerId("")}><X size={15} /></button></div><div className="form-grid"><label className="field">Amount received (₹)<input autoFocus required type="number" min="0.01" step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="300" /></label></div><div className="form-actions"><button className="button button-primary" disabled={busy}><Check size={14} /> Save payment</button></div></form>}
    </>;

    if (page === "Suppliers") return <>
      {heading("Suppliers", "A simple view of who supplies your shop and what’s due.", <div style={{ display: "flex", gap: 8 }}><button className="button button-secondary" onClick={() => setShowPurchaseForm(!showPurchaseForm)}><ShoppingCart size={14} /> Record purchase</button><button className="button button-primary" onClick={() => setShowSupplierForm(!showSupplierForm)}><Plus size={15} /> Add supplier</button></div>)}
      {showSupplierForm && <form className="form-card" onSubmit={submitSupplier}><div className="panel-heading"><h2 className="panel-title">Add a supplier</h2><button type="button" className="icon-button" onClick={() => setShowSupplierForm(false)}><X size={15} /></button></div><div className="form-grid"><label className="field">Supplier name<input name="name" required placeholder="e.g. Kumar Traders" /></label><label className="field">Phone number (optional)<input name="phone" type="tel" placeholder="Mobile number" /></label></div><div className="form-actions"><button className="button button-primary" disabled={busy}><Plus size={14} /> Save supplier</button></div></form>}
      {showPurchaseForm && <form className="form-card" onSubmit={submitPurchase}><div className="panel-heading"><div><h2 className="panel-title">Record a supplier purchase</h2><div className="panel-note">Stock and credit balances update after you confirm.</div></div><button type="button" className="icon-button" onClick={() => setShowPurchaseForm(false)}><X size={15} /></button></div><div className="form-grid"><label className="field">Supplier<select required name="supplier_id" defaultValue=""><option value="" disabled>Choose supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field">Product<select required name="product_id" defaultValue=""><option value="" disabled>Choose product</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="field">Quantity<input required name="quantity" type="number" step="0.001" min="0.001" placeholder="20" /></label><label className="field">Cost per unit (₹)<input required name="unit_price" type="number" step="0.01" min="0" placeholder="12" /></label><label className="field">Payment type<select name="payment_method" defaultValue="credit"><option value="credit">Credit</option><option value="cash">Cash</option><option value="upi">UPI</option></select></label></div><div className="form-actions"><button className="button button-primary" disabled={busy}><Check size={14} /> Review purchase</button></div></form>}
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Your suppliers</h2><div className="panel-note">Credit purchase balances are kept separately from operating expenses.</div></div><div className="search-box"><Search size={14} color="#89958c" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a supplier" /></div></div>
        {filteredSuppliers.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Supplier</th><th>Phone</th><th>Amount due</th><th>Action</th></tr></thead><tbody>{filteredSuppliers.map((s) => <tr key={s.id}><td><div className="product-name"><span className="product-thumb"><Store size={15} /></span>{s.name}</div></td><td>{s.phone || "—"}</td><td><strong>{rupees(s.balance)}</strong></td><td><button className="button button-secondary" style={{ minHeight: 32, padding: "0 9px" }} disabled={Number(s.balance) <= 0} onClick={() => { setPaySupplierId(s.id); setPaySupplierAmount(""); }}><CircleDollarSign size={13} /> Record payment</button></td></tr>)}</tbody></table></div> : <div className="empty-state">No suppliers found.</div>}
      </section>
      {paySupplierId && <form className="form-card" onSubmit={submitSupplierPayment} style={{ marginTop: 15 }}><div className="panel-heading"><div><h2 className="panel-title">Pay supplier</h2><div className="panel-note">{suppliers.find((s) => s.id === paySupplierId)?.name}</div></div><button type="button" className="icon-button" onClick={() => setPaySupplierId("")}><X size={15} /></button></div><div className="form-grid"><label className="field">Amount paid (₹)<input required autoFocus type="number" min="0.01" step="0.01" value={paySupplierAmount} onChange={(e) => setPaySupplierAmount(e.target.value)} placeholder="500" /></label></div><div className="form-actions"><button className="button button-primary" disabled={busy}><Check size={14} /> Review payment</button></div></form>}
    </>;

    if (page === "Expenses") return <>
      {heading("Expenses", "Track the everyday costs of running your shop.", <button className="button button-primary" onClick={() => setShowExpenseForm(!showExpenseForm)}><Plus size={15} /> Record expense</button>)}
      {showExpenseForm && <form className="form-card" onSubmit={submitExpense}><div className="panel-heading"><div><h2 className="panel-title">Record an expense</h2><div className="panel-note">Supplier purchases are tracked separately and aren’t counted here.</div></div><button type="button" className="icon-button" onClick={() => setShowExpenseForm(false)}><X size={15} /></button></div><div className="form-grid"><label className="field">Category<input name="category" required placeholder="e.g. Electricity" /></label><label className="field">Amount (₹)<input name="amount" required type="number" step="0.01" min="0.01" placeholder="350" /></label><label className="field">Paid by<select name="payment_method" defaultValue="cash"><option value="cash">Cash</option><option value="upi">UPI</option></select></label><label className="field">Note (optional)<input name="notes" placeholder="A short note" /></label></div><div className="form-actions"><button className="button button-primary" disabled={busy}><Check size={14} /> Save expense</button></div></form>}
      <div className="stats-grid"><Stat icon={<Wallet size={16} />} color="orange" label="Today's expenses" value={rupees(summary?.expenses)} note="Recorded operating costs" /><Stat icon={<FileText size={16} />} color="blue" label="This week's expenses" value={rupees(weekly?.expenses)} note="Last 7 days" /></div>
      <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Expense history</h2><div className="panel-note">Supplier purchases and payments are not included.</div></div><div className="search-box"><Search size={14} color="#89958c" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a category" /></div></div>
        {filteredExpenses.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Category</th><th>When</th><th>Payment</th><th>Note</th><th>Amount</th></tr></thead><tbody>{filteredExpenses.map((expense) => <tr key={expense.id}><td><strong>{expense.category}</strong></td><td>{new Date(expense.created_at).toLocaleDateString("en-IN")}</td><td>{expense.payment_method.toUpperCase()}</td><td>{expense.notes || "—"}</td><td><strong>{rupees(expense.amount)}</strong></td></tr>)}</tbody></table></div> : <div className="empty-state">No expenses recorded.</div>}
      </section>
    </>;

    return <>
      {heading("Reports & insights", "A clear picture, based only on what you’ve recorded.")}
      <div className="stats-grid"><Stat icon={<CircleDollarSign size={17} />} color="green" label="Today’s sales" value={rupees(summary?.sales)} note="Recorded revenue" /><Stat icon={<TrendingUp size={16} />} color="blue" label="Today’s gross profit" value={rupees(summary?.gross_profit)} note="Sales less itemised product costs" /><Stat icon={<Wallet size={16} />} color="orange" label="Net operating earnings" value={rupees(summary?.net_operating_earnings)} note="Gross profit less recorded expenses" /><Stat icon={<BarChart3 size={16} />} color="purple" label="Weekly sales" value={rupees(weekly?.sales)} note="Last 7 days" /></div>
      <div className="dashboard-grid">
        <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Seven-day summary</h2><div className="panel-note">Calculated from your recorded business activity</div></div></div><ReportRow label="Sales revenue" value={rupees(weekly?.sales)} /><ReportRow label="Estimated gross profit" value={rupees(weekly?.gross_profit)} /><ReportRow label="Operating expenses" value={rupees(weekly?.expenses)} /><ReportRow label="Estimated net operating earnings" value={rupees(weekly?.net_operating_earnings)} strong /><p className="panel-note" style={{ marginTop: 13 }}>Profit is an estimate based on itemised sales and each product’s current recorded purchase price. Aggregated sales without item-level costs aren’t included in profit.</p></section>
        <section className="panel"><div className="panel-heading"><div><h2 className="panel-title">Customer & supplier dues</h2><div className="panel-note">Calculated from ledger entries</div></div></div><ReportRow label="Customers owe" value={rupees(summary?.customer_dues)} /><ReportRow label="You owe suppliers" value={rupees(summary?.supplier_dues)} /><ReportRow label="Products at low stock" value={String(summary?.low_stock_count || 0)} /><button className="button button-secondary" style={{ marginTop: 10 }} onClick={() => setPage("Inventory")}>View reorder suggestions <ChevronRight size={13} /></button></section>
      </div>
      <section className="panel" style={{ marginTop: 17 }}><div className="panel-heading"><div><h2 className="panel-title">Suggested reorders</h2><div className="panel-note">Transparent estimates from the last 30 days of recorded sales and your minimum stock levels.</div></div></div>{reorder.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Product</th><th>Stock</th><th>Minimum</th><th>Suggested order</th><th>Basis</th></tr></thead><tbody>{reorder.map((p) => <tr key={p.product_id}><td><strong>{p.name}</strong></td><td>{p.stock}</td><td>{p.min_stock}</td><td>{p.suggested_quantity}</td><td>{p.history_sufficient ? `Avg. ${p.average_daily_sales}/day` : "Insufficient sales history"}</td></tr>)}</tbody></table></div> : <div className="empty-state">No reorder suggestions right now.</div>}</section>
    </>;
  })();

  if (!shop) {
    return (
      <main className="login-page" aria-busy="true">
        <section className="login-card" role="status">
          <h1>Loading your shop…</h1>
          <p className="panel-note">Getting your shop details and language. Voice and business controls open when this finishes.</p>
          <button type="button" className="button button-secondary" style={{ marginTop: 13 }} onClick={signOut}>Sign out</button>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Store size={20} /></div><div><div className="brand-name">KaamSaathi</div><div className="brand-tag">YOUR SHOP. YOUR LANGUAGE.</div></div></div>
        <div className="nav-caption">YOUR SHOP</div>
        <nav className="nav-list" aria-label="Main navigation">
          {navItems.map(({ name, icon: Icon }) => <button key={name} onClick={() => { voiceSession.stop(); setPage(name); setSearch(""); }} className={`nav-button ${page === name ? "active" : ""}`}><Icon size={17} strokeWidth={1.8} /><span>{name}</span></button>)}
        </nav>
        <button className="nav-button" onClick={handOverToCustomer}><ShoppingBag size={17} /><span>Start customer shopping</span></button>
        <div className="sidebar-bottom"><div className="nav-caption">ACCOUNT</div><button className="nav-button" onClick={signOut}><LogOut size={17} /><span>Sign out</span></button><div className="shop-mini"><div className="shop-avatar">{initial}</div><div><div className="shop-name">{shop?.name || "Your shop"}</div><div className="shop-caption">{shop?.is_demo ? "Demo shop · " : ""}{shop?.address || "Your shop"}</div></div><Settings2 size={14} color="#94a096" style={{ marginLeft: "auto" }} /></div></div>
      </aside>
      <main className="main-area">
        <header className="topbar"><div className="breadcrumbs">Your shop <ChevronRight size={12} style={{ verticalAlign: "middle", margin: "0 5px" }} /> <strong>{page}</strong></div><div className="top-actions">
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}><Languages size={14} color="#77857b" /><select aria-label="Preferred language" className="language-select" value={language} disabled={languageSaving} onChange={(e) => void updateLanguage(e.target.value)}><option value="hi-IN">हिन्दी</option><option value="en-IN">English</option><option value="ta-IN">தமிழ்</option></select></label>
          {page !== "Translator" && page !== "Customer orders" && <button className="icon-button" title="Talk to Saathi" onClick={() => setCompanionOpen(true)} style={{ color: "var(--green)" }}><Mic size={16} /></button>}
          <div className="top-avatar">{initial}</div>
        </div></header>
        <div className="content">{body}</div>
        <div className={page === "Voice assistant" ? "companion-page" : "companion-overlay"} hidden={page === "Translator" || (page !== "Voice assistant" && !companionOpen)}>
          {page !== "Voice assistant" && <button className="button button-secondary companion-close" onClick={() => { voiceSession.stop(); setCompanionOpen(false); }}>Close assistant</button>}
          {assistantPanel()}
        </div>
      </main>
      {page !== "Voice assistant" && page !== "Translator" && page !== "Customer orders" && <button className="companion-launch" aria-label="Open voice assistant" onClick={() => setCompanionOpen(true)}><Mic size={23} />{pending && <span className="companion-pending">Confirmation waiting</span>}</button>}
      {shop?.language_configured === false && <div className="confirmation-overlay" role="dialog" aria-modal="true" aria-labelledby="language-title"><div className="confirm-box">
        <h2 id="language-title">Choose your shop language</h2><p>You can change this later in the top bar.</p>
        <label className="field">Preferred language<select value={onboardingLanguage} onChange={(event) => setOnboardingLanguage(event.target.value)}><option value="hi-IN">हिन्दी</option><option value="en-IN">English</option><option value="ta-IN">தமிழ்</option></select></label>
        <div className="form-actions"><button className="button button-primary" disabled={languageSaving} onClick={() => void updateLanguage(onboardingLanguage)}>{languageSaving ? "Saving…" : "Save language"}</button></div>
      </div></div>}
      {businessPending && <div className="confirmation-overlay" role="dialog" aria-modal="true" aria-labelledby="confirmation-title"><div className="confirm-box"><div className="confirm-title" id="confirmation-title"><AlertTriangle size={16} /> Please confirm this change</div><div className="confirm-summary">{businessPending.summary}</div><div className="confirm-actions"><button className="button button-secondary" disabled={busy} onClick={() => resolveBusinessPending(false)}><X size={14} /> No, cancel</button><button className="button button-primary" disabled={busy} onClick={() => resolveBusinessPending(true)}><Check size={14} /> Yes, confirm</button></div></div></div>}
      {toast && <div role="status" className="toast">{toast}</div>}
    </div>
  );
}

function Stat({ icon, color, label, value, note }: { icon: ReactNode; color: string; label: string; value: string; note: string }) {
  return <article className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${color}`}>{icon}</span></div><div className="stat-value money">{value}</div><div className="stat-foot">{note}</div></article>;
}

function ReportRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 15, padding: "12px 0", borderBottom: "1px solid #f0f2ef", fontSize: 12, fontWeight: strong ? 700 : 500 }}><span className={strong ? "" : "muted"}>{label}</span><span>{value}</span></div>;
}
