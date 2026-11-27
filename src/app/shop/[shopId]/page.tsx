import type { Metadata } from "next";
import ShoppingApp from "./shopping-app";
import "../shopping.css";

export const metadata: Metadata = {
  title: "Shop with KaamSaathi",
  description: "Browse and order from your local shop.",
  manifest: "/shopping.webmanifest",
};

export default async function ShopPage({ params }: { params: Promise<{ shopId: string }> }) {
  const { shopId } = await params;
  return <ShoppingApp shopId={shopId} />;
}
