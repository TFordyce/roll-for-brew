import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
