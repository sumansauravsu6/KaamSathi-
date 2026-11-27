"use client";

import { useEffect, useRef, useState } from "react";
import ShoppingApp from "./shop/[shopId]/shopping-app";
import "./shop/shopping.css";

type PublicShop = { id: string; name: string; address: string };

export default function CustomerEntry({ shopId, onChooseShop, onMerchant }: {
  shopId: string; onChooseShop: (id: string) => void; onMerchant: () => void;
}) {
  const [query, setQuery] = useState("");
  const [shops, setShops] = useState<PublicShop[]>([]);
  const [status, setStatus] = useState("Enter your shop's name. No sign-in, QR code, hearing or speech is required.");
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!shopId) heading.current?.focus();
    return () => searchAbort.current?.abort();
  }, [shopId]);

  if (shopId) return <ShoppingApp key={shopId} shopId={shopId} embedded
    onChooseShop={() => onChooseShop("")} onMerchant={onMerchant} />;

  return <div className="shopping shopping-simple">
    <main className="shopping-main shopping-entry">
      <nav aria-label="App mode" className="shopping-mode-nav">
        <button type="button" className="shopping-button shopping-secondary" onClick={onMerchant}><span aria-hidden="true">&larr; </span>Back to main app</button>
      </nav>
      <h1 ref={heading} tabIndex={-1}>Shop with KaamSaathi</h1>
      <p>Customer shopping is built into this app. Choose the shop, then shop one step at a time.</p>
      <p>Use touch, keyboard, switch input or your screen reader. A connected Braille display works through your device's screen reader; the app does not require audio.</p>
      <form className="shopping-section" onSubmit={(event) => {
        event.preventDefault();
        searchAbort.current?.abort();
        const controller = new AbortController();
        searchAbort.current = controller;
        setBusy(true); setShops([]); setStatus("Searching shops.");
        void (async () => {
          try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/public/shops?q=${encodeURIComponent(query.trim())}`, {
              cache: "no-store", credentials: "omit", signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Shop search failed (${response.status}). Please try again.`);
            const rows: PublicShop[] = await response.json();
            if (controller.signal.aborted) return;
            setShops(rows);
            setStatus(rows.length ? `${rows.length} shops found. Choose your shop below.${rows.length === 10 ? " Refine the name if your shop is not shown." : ""}` : "No matching shops with products found. Check the name with the shopkeeper.");
          } catch (error) {
            if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Cannot reach shop search. Check your connection.");
          } finally { if (!controller.signal.aborted) setBusy(false); }
        })();
      }}>
        <label>Shop name<input autoComplete="off" required minLength={2} maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="shopping-button" disabled={busy || query.trim().length < 2}>{busy ? "Searching..." : "Find my shop"}</button>
      </form>
      <p role="status" aria-atomic="true">{status}</p>
      <ul className="shopping-shop-list" aria-label="Matching shops">{shops.map((shop) => <li key={shop.id}>
        <h2>{shop.name}</h2><p>{shop.address || "Ask the shopkeeper if more than one shop has this name."}</p>
        <button className="shopping-button" onClick={() => onChooseShop(shop.id)}>Shop at {shop.name}</button>
      </li>)}</ul>
    </main>
  </div>;
}
