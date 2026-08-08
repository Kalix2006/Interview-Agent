import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Interview Agent",
  description: "AI-powered technical interview agent",
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
