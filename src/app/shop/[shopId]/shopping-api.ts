export type Language = "en-IN" | "hi-IN" | "ta-IN";
export type Product = { id: string; name: string; category: string; unit: string; price: string; available: string };
export type Shop = { id: string; name: string; address: string; language: string; is_demo: boolean; products: Product[] };
export type CartItem = { product_id: string; name: string; unit: string; quantity: string; unit_price: string; line_total: string };
export type Message = { id: string; sender: "customer" | "shopkeeper"; text: string; language: string; created_at: string };
export type Order = {
  id: string; shop_id: string;
  status: "draft" | "pending_shopkeeper_confirmation" | "accepted" | "rejected" | "ready_for_collection" | "completed" | "cancelled";
  revision: number; reviewed_revision: number | null; checkout_confirmation_pending: boolean; total: string;
  items: CartItem[]; customer_name: string; notes: string; created_at: string; updated_at: string; sale_id: string | null;
  proposal: null | { original_product_id: string; replacement_product_id: string; quantity: string; replacement_name: string; replacement_unit: string; unit_price: string; total: string; note: string; items: CartItem[] };
  messages: Message[]; events: { id: string; status: string; note: string; created_at: string }[];
};
export type AssistantResult = { text: string; cart: Order; products: Product[] | null; confirmation_required: boolean; tool_results: unknown[] };

export class ShoppingError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const apiBase = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/+$/, "");

export async function request<T>(shopId: string, path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Shopping-Token", token);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/public/shops/${encodeURIComponent(shopId)}${path}`, {
      ...init, headers, cache: "no-store", credentials: "omit",
    });
  } catch {
    throw new ShoppingError("Cannot reach the shop. Check your connection and try again. Offline checkout is not available.", 0);
  }
  if (!response.ok) {
    let detail: unknown;
    try { detail = (await response.json()).detail; } catch { /* Non-JSON error. */ }
    throw new ShoppingError(errorDetailMessage(detail, `The request failed (${response.status}). Please try again.`), response.status);
  }
  return response.json() as Promise<T>;
}

export function body(value: unknown): string { return JSON.stringify(value); }
export function money(value: string): string { return `₹${value}`; }
export function statusLabel(status: string): string { return status.replace(/_/g, " "); }
import { errorDetailMessage } from "../../voice-helpers";

