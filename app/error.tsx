"use client";

export default function Error({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-black text-slate-950">
          Не удалось загрузить раздел
        </h1>
        <p className="mt-3 text-sm font-medium leading-6 text-slate-700">
          Страница не открылась из‑за внутренней ошибки. Финансовые цифры не
          отображаются и не считаются равными нулю.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-5 rounded-2xl bg-slate-950 px-4 py-2 text-sm font-black text-white"
        >
          Повторить
        </button>
      </div>
    </section>
  );
}
