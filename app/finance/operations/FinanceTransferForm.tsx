"use client";

import { useMemo, useState } from "react";

type Company = {
  id: string;
  name: string;
};

type BankAccount = {
  name: string;
  companyName: string;
};

type Props = {
  companies: Company[];
  accounts: BankAccount[];
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export default function FinanceTransferForm({ companies, accounts }: Props) {
  const defaultCompanyName = companies[0]?.name ?? "";
  const defaultAccounts = accounts.filter(
    (account) => account.companyName === defaultCompanyName
  );

  const [operationDate, setOperationDate] = useState(todayIsoDate());
  const [companyName, setCompanyName] = useState(defaultCompanyName);
  const [fromAccount, setFromAccount] = useState(defaultAccounts[0]?.name ?? "");
  const [toAccount, setToAccount] = useState(
    defaultAccounts[1]?.name ?? defaultAccounts[0]?.name ?? ""
  );
  const [amount, setAmount] = useState("");
  const [comment, setComment] = useState("");

  const companyAccounts = useMemo(() => {
    return accounts.filter((account) => account.companyName === companyName);
  }, [accounts, companyName]);

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm">
      <div>
        <h2 className="text-xl font-bold text-slate-900">
          Внутренний перевод между счетами
        </h2>

        <p className="mt-1 text-sm text-slate-500">
          Перевод доступен только между счетами одной выбранной компании.
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
          value={companyName}
          onChange={(event) => {
            const nextCompanyName = event.target.value;
            const nextAccounts = accounts.filter(
              (account) => account.companyName === nextCompanyName
            );

            setCompanyName(nextCompanyName);
            setFromAccount(nextAccounts[0]?.name ?? "");
            setToAccount(nextAccounts[1]?.name ?? nextAccounts[0]?.name ?? "");
          }}
          className="rounded-xl border border-slate-300 px-3 py-2"
        >
          {companies.map((company) => (
            <option key={company.id} value={company.name}>
              {company.name}
            </option>
          ))}
        </select>

        <select
          name="fromAccount"
          required
          value={fromAccount}
          onChange={(event) => setFromAccount(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="">Откуда списать</option>
          {companyAccounts.map((account) => (
            <option key={`${account.companyName}-${account.name}`} value={account.name}>
              {account.name}
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
          {companyAccounts.map((account) => (
            <option key={`${account.companyName}-${account.name}`} value={account.name}>
              {account.name}
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
          disabled={companyAccounts.length < 2 || fromAccount === toAccount}
        >
          Перевести
        </button>
      </form>

      {companyAccounts.length < 2 && (
        <p className="mt-3 text-sm text-red-600">
          Для внутреннего перевода нужно минимум два счёта у выбранной компании.
        </p>
      )}

      {companyAccounts.length >= 2 && fromAccount === toAccount && (
        <p className="mt-3 text-sm text-red-600">
          Счёт списания и счёт зачисления не должны совпадать.
        </p>
      )}
    </section>
  );
}