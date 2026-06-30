"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function getSafeNextPath(value: string | null) {
  const next = value || "/";

  if (!next.startsWith("/") || next.startsWith("/login") || next.startsWith("//")) {
    return "/";
  }

  return next;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const next = getSafeNextPath(searchParams.get("next"));

  const [email, setEmail] = useState("saitema77@gmail.com");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState("");

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setIsLoading(true);
    setErrorText("");

    try {
      const response = await fetch("/api/local-auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          next,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.ok) {
        setErrorText(data?.message || "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0432\u043e\u0439\u0442\u0438. \u041f\u0440\u043e\u0432\u0435\u0440\u044c email \u0438 \u043f\u0430\u0440\u043e\u043b\u044c.");
        return;
      }

      window.location.href = data.next || next;
    } catch {
      setErrorText("\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0432\u043e\u0439\u0442\u0438. \u041f\u043e\u0432\u0442\u043e\u0440\u0438 \u043f\u043e\u0437\u0436\u0435.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-sm">
      <h1 className="text-3xl font-bold text-slate-900">
        Marketplace Business OS
      </h1>
      <p className="mt-3 text-sm text-slate-500">
        {"\u0412\u0445\u043e\u0434 \u0432 \u0437\u0430\u043a\u0440\u044b\u0442\u0443\u044e \u0444\u0438\u043d\u0430\u043d\u0441\u043e\u0432\u0443\u044e \u0441\u0438\u0441\u0442\u0435\u043c\u0443."}
      </p>

      <form onSubmit={handleLogin} className="mt-8 space-y-5">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
            required
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">{"\u041f\u0430\u0440\u043e\u043b\u044c"}</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm outline-none transition focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
            required
          />
        </label>

        {errorText ? (
          <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            {errorText}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={isLoading}
          className="w-full rounded-2xl bg-slate-950 px-4 py-3 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-400"
        >
          {isLoading ? "\u0412\u0445\u043e\u0434\u0438\u043c..." : "\u0412\u043e\u0439\u0442\u0438"}
        </button>
      </form>

      <p className="mt-4 text-xs leading-5 text-slate-400">
        {"\u0412\u0440\u0435\u043c\u0435\u043d\u043d\u0430\u044f \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f \u0431\u0435\u0437 Supabase Auth. \u041f\u043e\u0441\u043b\u0435 \u0438\u0441\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u044f \u0441\u0435\u0442\u0438 \u0432\u0435\u0440\u043d\u0451\u043c Supabase Auth."}
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-[calc(100vh-0px)] items-center justify-center bg-slate-100 px-4 py-10">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
