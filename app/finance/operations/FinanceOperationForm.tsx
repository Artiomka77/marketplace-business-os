"use client";

import { useMemo, useRef, useState } from "react";

type Category = {
  id: string;
  name: string;
  categoryType: string;
  parentName: string | null;
  profitTreatment?: string | null;
};

type Company = {
  id: string;
  name: string;
};

type BankAccount = {
  name: string;
  companyName: string;
};

type Props = {
  categories: Category[];
  companies: Company[];
  bankAccounts: BankAccount[];
};

const profitTreatmentOptions = [
  {
    value: "AUTO",
    label: "Авто / временно",
    description: "Пока система определяет роль по названию статьи.",
  },
  {
    value: "INCLUDE_IN_NET_PROFIT",
    label: "В чистую прибыль",
    description: "Влияет на ДДС и чистую прибыль бизнеса.",
  },
  {
    value: "CASH_ONLY",
    label: "Только ДДС",
    description: "Деньги ушли/пришли, но в прибыль повторно не включается.",
  },
  {
    value: "CREDIT_PRINCIPAL",
    label: "Тело кредита",
    description: "Влияет на ДДС, но не уменьшает чистую прибыль.",
  },
  {
    value: "CREDIT_INTEREST",
    label: "Проценты кредита",
    description: "Влияет на ДДС и уменьшает чистую прибыль.",
  },
  {
    value: "CREDIT_RECEIVED",
    label: "Получение кредита",
    description: "Денежное поступление в ДДС, но не доход бизнеса.",
  },
  {
    value: "OWNER_WITHDRAWAL",
    label: "Вывод собственника",
    description: "Влияет на ДДС и показатель после вывода собственника.",
  },
  {
    value: "IGNORE",
    label: "Не учитывать",
    description: "Не участвует в расчётах прибыли и ДДС.",
  },
];

function typeLabel(type: string) {
  if (type === "INCOME") return "Доход";
  if (type === "EXPENSE") return "Расход";
  if (type === "TRANSFER") return "Перевод";
  if (type === "FINANCING") return "Финансы";
  if (type === "PERSONAL") return "Личные";
  return type || "—";
}

function typeClassName(type: string) {
  if (type === "INCOME") return "text-emerald-700";
  if (type === "EXPENSE") return "text-red-700";
  if (type === "TRANSFER") return "text-slate-600";
  if (type === "FINANCING") return "text-blue-700";
  if (type === "PERSONAL") return "text-amber-700";
  return "text-slate-700";
}

function treatmentLabel(value?: string | null) {
  return (
    profitTreatmentOptions.find((option) => option.value === value)?.label ??
    "Авто / временно"
  );
}

function treatmentDescription(value?: string | null) {
  return (
    profitTreatmentOptions.find((option) => option.value === value)
      ?.description ?? "Пока система определяет роль по названию статьи."
  );
}

function treatmentClassName(value?: string | null) {
  if (value === "INCLUDE_IN_NET_PROFIT") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }

  if (value === "CASH_ONLY") {
    return "bg-cyan-50 text-cyan-700 ring-cyan-200";
  }

  if (value === "CREDIT_PRINCIPAL") {
    return "bg-blue-50 text-blue-700 ring-blue-200";
  }

  if (value === "CREDIT_INTEREST") {
    return "bg-violet-50 text-violet-700 ring-violet-200";
  }

  if (value === "CREDIT_RECEIVED") {
    return "bg-indigo-50 text-indigo-700 ring-indigo-200";
  }

  if (value === "OWNER_WITHDRAWAL") {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }

  if (value === "IGNORE") {
    return "bg-slate-100 text-slate-500 ring-slate-200";
  }

  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export default function FinanceOperationForm({
  categories,
  companies,
  bankAccounts,
}: Props) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);

  const defaultCompanyName = companies[0]?.name ?? "";
  const defaultCompanyAccounts = bankAccounts.filter(
    (account) => account.companyName === defaultCompanyName
  );

  const defaultCategory =
    categories.find((category) => category.categoryType === "EXPENSE") ??
    categories[0] ??
    null;

  const [operationType, setOperationType] = useState(
    defaultCategory?.categoryType ?? "EXPENSE"
  );
  const [companyName, setCompanyName] = useState(defaultCompanyName);
  const [operationDate, setOperationDate] = useState(todayIsoDate());
  const [bankAccount, setBankAccount] = useState(
    defaultCompanyAccounts[0]?.name ?? ""
  );
  const [comment, setComment] = useState("");
  const [amount, setAmount] = useState("");

  const [categorySearch, setCategorySearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(
    defaultCategory?.name ?? ""
  );
  const [showCategories, setShowCategories] = useState(false);
  const [showExtra, setShowExtra] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");

  const companyAccounts = useMemo(() => {
    return bankAccounts.filter((account) => account.companyName === companyName);
  }, [bankAccounts, companyName]);

  const selectedCategoryData = useMemo(() => {
    return (
      categories.find(
        (category) =>
          category.name === selectedCategory &&
          category.categoryType === operationType
      ) ??
      categories.find((category) => category.name === selectedCategory) ??
      null
    );
  }, [categories, operationType, selectedCategory]);

  const filteredCategories = useMemo(() => {
    const query = categorySearch.toLowerCase().trim();

    return categories
      .filter((category) => category.categoryType === operationType)
      .filter((category) => {
        if (!query) return true;

        return `${category.name} ${category.parentName ?? ""} ${treatmentLabel(
          category.profitTreatment
        )}`
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 30);
  }, [categories, operationType, categorySearch]);

  async function handleSubmit(formData: FormData) {
    const response = await fetch("/api/finance/operations", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      setSavedMessage("Ошибка сохранения");
      return;
    }

    setSavedMessage("Сохранено ✓");
    setAmount("");
    setComment("");
    setCategorySearch("");

    setTimeout(() => {
      amountRef.current?.focus();
    }, 50);

    setTimeout(() => {
      setSavedMessage("");
    }, 2000);

    window.location.reload();
  }

  function submitOnEnter(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Enter") return;

    const target = event.target as HTMLElement;

    if (target.tagName === "TEXTAREA") return;

    event.preventDefault();
    formRef.current?.requestSubmit();
  }

  function selectCategory(category: Category) {
    setSelectedCategory(category.name);
    setCategorySearch("");
    setShowCategories(false);
    setTimeout(() => amountRef.current?.focus(), 50);
  }

  function changeOperationType(nextType: string) {
    setOperationType(nextType);

    const nextCategory =
      categories.find((category) => category.categoryType === nextType)?.name ??
      "";

    setSelectedCategory(nextCategory);
    setCategorySearch("");
  }

  return (
    <form
      ref={formRef}
      action={handleSubmit}
      onKeyDown={submitOnEnter}
      className="rounded-2xl bg-white p-6 shadow-sm"
    >
      <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Быстро добавить операцию
          </h2>

          <p className="mt-1 text-sm text-slate-500">
            Счета фильтруются по выбранной компании. Роль статьи влияет на ДДС,
            P&amp;L, кредиты и вывод собственника.
          </p>
        </div>

        {savedMessage && (
          <div className="rounded-xl bg-emerald-50 px-4 py-2 font-semibold text-emerald-700">
            {savedMessage}
          </div>
        )}
      </div>

      <div className="grid gap-3 xl:grid-cols-[130px_150px_130px_1fr_180px_150px_1fr_140px]">
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
            const nextAccounts = bankAccounts.filter(
              (account) => account.companyName === nextCompanyName
            );

            setCompanyName(nextCompanyName);
            setBankAccount(nextAccounts[0]?.name ?? "");
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
          name="operationType"
          required
          value={operationType}
          onChange={(event) => changeOperationType(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="INCOME">Доход</option>
          <option value="EXPENSE">Расход</option>
          <option value="TRANSFER">Перевод</option>
          <option value="FINANCING">Финансы</option>
          <option value="PERSONAL">Личные</option>
        </select>

        <div className="relative">
          <input type="hidden" name="category" value={selectedCategory} />

          <input
            value={categorySearch || selectedCategory}
            onChange={(event) => {
              setCategorySearch(event.target.value);
              setShowCategories(true);
            }}
            onFocus={() => setShowCategories(true)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Найти статью"
          />

          {showCategories && (
            <div className="absolute z-20 mt-2 max-h-96 w-full overflow-auto rounded-xl border border-slate-200 bg-white shadow-lg">
              {filteredCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => selectCategory(category)}
                  className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-100"
                >
                  <div className="font-medium text-slate-900">
                    {category.name}
                  </div>

                  <div className="mt-1 text-xs text-slate-500">
                    {typeLabel(category.categoryType)}
                    {category.parentName ? ` · ${category.parentName}` : ""}
                  </div>

                  <div
                    className={`mt-2 inline-flex rounded-full px-2 py-1 text-[11px] font-bold ring-1 ${treatmentClassName(
                      category.profitTreatment
                    )}`}
                  >
                    {treatmentLabel(category.profitTreatment)}
                  </div>
                </button>
              ))}

              {filteredCategories.length === 0 && (
                <div className="px-4 py-3 text-sm text-slate-500">
                  Ничего не найдено
                </div>
              )}
            </div>
          )}
        </div>

        <select
          name="bankAccount"
          required
          value={bankAccount}
          onChange={(event) => setBankAccount(event.target.value)}
          className="rounded-xl border border-slate-300 px-3 py-2"
        >
          {companyAccounts.length === 0 && (
            <option value="">Сначала создайте счёт</option>
          )}

          {companyAccounts.map((account) => (
            <option
              key={`${account.companyName}-${account.name}`}
              value={account.name}
            >
              {account.name}
            </option>
          ))}
        </select>

        <input
          ref={amountRef}
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

        <button className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
          Сохранить
        </button>
      </div>

      {selectedCategoryData && (
        <div
          className={`mt-4 rounded-2xl px-4 py-3 text-sm ring-1 ${treatmentClassName(
            selectedCategoryData.profitTreatment
          )}`}
        >
          <div className="font-bold">
            {selectedCategoryData.name} ·{" "}
            {treatmentLabel(selectedCategoryData.profitTreatment)}
          </div>

          <div className="mt-1">
            {treatmentDescription(selectedCategoryData.profitTreatment)}
          </div>

          <div className="mt-1 text-xs opacity-80">
            Тип: {typeLabel(selectedCategoryData.categoryType)}
            {selectedCategoryData.parentName
              ? ` · Группа: ${selectedCategoryData.parentName}`
              : ""}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowExtra((value) => !value)}
        className="mt-4 text-sm font-medium text-slate-600 hover:text-slate-900"
      >
        {showExtra ? "Скрыть дополнительные поля ▲" : "Дополнительные поля ▼"}
      </button>

      {showExtra && (
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <input
            name="obligationDate"
            type="date"
            className="rounded-xl border border-slate-300 px-3 py-2"
          />

          <input
            name="subcategory"
            className="rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Подстатья"
          />

          <input
            name="counterparty"
            className="rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Контрагент"
          />

          <input
            name="project"
            className="rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Проект / направление"
          />

          <label className="flex items-center gap-3 text-sm text-slate-700">
            <input
              type="checkbox"
              name="isInternalTransfer"
              className="h-4 w-4"
            />
            Внутренний перевод
          </label>
        </div>
      )}
    </form>
  );
}