import type { Metadata } from "next";

import "./globals.css";
import AppNav from "@/components/app/AppNav";

export const metadata: Metadata = {
  title: "Marketplace OS",
  description: "Marketplace analytics system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" data-sidebar="expanded">
      <body className="bg-background font-sans text-slate-950 antialiased">
        <AppNav />
        <div className="app-content min-h-screen">{children}</div>
      </body>
    </html>
  );
}
