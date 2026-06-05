import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./globals.css";
import AppNav from "@/components/app/AppNav";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
});

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
      <body className={inter.className}>
        <AppNav />
        {children}
      </body>
    </html>
  );
}