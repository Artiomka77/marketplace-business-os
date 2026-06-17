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
      <body className="bg-slate-100 font-sans text-slate-900 antialiased">
        <AppNav />
        {children}
      </body>
    </html>
  );
}