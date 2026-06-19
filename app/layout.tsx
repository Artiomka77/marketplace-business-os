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
    <html lang="ru">
      <body className="bg-background font-sans text-slate-950 antialiased">
        <AppNav />
        <div className="min-h-screen lg:pl-72">{children}</div>
      </body>
    </html>
  );
}
