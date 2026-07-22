import type { Metadata } from "next";
import { Cinzel, Inter } from "next/font/google";
import "./globals.css";

// Tabletop design-system fonts (issue #64): Cinzel for small-caps-style
// engraved headings/labels on the card-frame chrome, Inter for legible
// off-white body copy (player names, data). Exposed as CSS variables so
// tailwind.config.ts's fontFamily.display/body tokens can reference them
// from any component, not just this layout.
const cinzel = Cinzel({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-display" });
const inter = Inter({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Roll for Brew",
  description: "Roll a d20 to decide who makes the tea round.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${cinzel.variable} ${inter.variable}`}>
      <body className="font-body">{children}</body>
    </html>
  );
}
