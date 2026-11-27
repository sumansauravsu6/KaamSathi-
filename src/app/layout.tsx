import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KaamSaathi — Your shop. Your language. Just speak.",
  description: "A voice-first business companion for your kirana shop.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
