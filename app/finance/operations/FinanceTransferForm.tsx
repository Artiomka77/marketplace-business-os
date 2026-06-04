"use client";

import { useState } from "react";

type Props = {
  accounts: string[];
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export default function FinanceTransferForm({ accounts }: Props) {
  const [operationDate, setOperationDate] = useState(todayIsoDate());
  const [fromAccount, setFromAccount] = useState(accounts[0] ?? "");
  const [toAccount, setToAccount] = useState(accounts[1] ?? accounts[0] ?? "");
  const [amount, setAmount] = useState("");
  const [comment, setComment] = useState("");

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm">
      <div>
        <h2 className="text-xl font-bold text-slate-900">
          Внутренний перевод между счетами
        </h2>

        <p className="mt-1 text-sm text-slate-500">
          Создаёт две операции: списание с одного счёта и зачисление на другой.
        </p>
      </div>

      <form
        action="/api/finance/transfers"
        method="POST"
        className="mt-6 grid gap-3 xl:grid-cols-[130px_150px_1fr_1fr_150px_1fr_140px]"
      >
        <input
          type="date"
          name="operationDate"
          required
          value={operationDate}
          onChange={(event) => setOperationDate(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
        />

        <select
          name="companyName"
          required
          defaultValue="ИП Петров"
          className="rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="ИП Петров">ИП Петров</option>
          <option value="ИП Лебедева">ИП Лебедева</option>
        </select>

        <select
          name="fromAccount"
          required
          value={fromAccount}
          onChange={(event) => setFromAccount(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="">Откуда списать</option>
          {accounts.map((account) => (
            <option key={account} value={account}>
              {account}
            </option>
          ))}
        </select>

        <select
          name="toAccount"
          required
          value={toAccount}
          onChange={(event) => setToAccount(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="">Куда зачислить</option>
          {accounts.map((account) => (
            <option key={account} value={account}>
              {account}
            </option>
          ))}
        </select>

        <input
          name="amount"
          required
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
          placeholder="Сумма"
        />

        <input
          name="comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
          placeholder="Комментарий"
        />

        <button
          className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white disabled:bg-slate-300"
          disabled={accounts.length < 2 || fromAccount === toAccount}
        >
          Перевести
        </button>
      </form>

      {accounts.length < 2 && (
        <p className="mt-3 text-sm text-red-600">
          Для внутреннего перевода нужно минимум два счёта.
        </p>
      )}

      {accounts.length >= 2 && fromAccount === toAccount && (
        <p className="mt-3 text-sm text-red-600">
          Счёт списания и счёт зачисления не должны совпадать.
        </p>
      )}
    </section>
  );
}