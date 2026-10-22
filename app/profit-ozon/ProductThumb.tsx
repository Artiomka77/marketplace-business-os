"use client";

import { useState } from "react";

export function ProductThumb({
  urls,
  alt,
}: {
  urls: string[];
  alt: string;
}) {
  const [index, setIndex] = useState(0);
  const safeUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
  const src = safeUrls[index] || "";

  if (!src) {
    return (
      <div className="flex h-16 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-2xl border border-slate-200 bg-slate-50 text-[9px] font-black uppercase tracking-wide text-slate-400">
        <span aria-hidden="true">▣</span>
        <span>нет фото</span>
      </div>
    );
  }

  return (
    <div className="flex h-16 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover"
        onError={() =>
          setIndex((current) =>
            current + 1 < safeUrls.length ? current + 1 : safeUrls.length
          )
        }
      />
    </div>
  );
}
