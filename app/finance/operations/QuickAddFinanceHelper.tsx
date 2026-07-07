"use client";

import { useEffect } from "react";

function formatAmount(value: string) {
  const normalized = String(value || "")
    .replace(/\u00A0/g, " ")
    .replace(/[^0-9,.]/g, "")
    .replace(/\./g, ",");

  const hasComma = normalized.includes(",");
  const parts = normalized.split(",");
  const integerPart = (parts[0] || "").replace(/^0+(?=\d)/, "");
  const decimals = parts.slice(1).join("").slice(0, 2);

  const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

  if (hasComma) {
    return `${formattedInteger || "0"},${decimals}`;
  }

  return formattedInteger;
}

export default function QuickAddFinanceHelper() {
  useEffect(() => {
    const operationType = document.getElementById(
      "quick-operation-type",
    ) as HTMLSelectElement | null;

    const category = document.getElementById(
      "quick-category",
    ) as HTMLSelectElement | null;

    const amount = document.getElementById(
      "quick-amount",
    ) as HTMLInputElement | null;

    function syncCategories() {
      if (!operationType || !category) return;

      const selectedType = operationType.value;
      const selectedOption = category.options[category.selectedIndex];

      Array.from(category.options).forEach((option) => {
        if (!option.value) {
          option.hidden = false;
          option.disabled = false;
          return;
        }

        const categoryType = option.dataset.categoryType;
        const isVisible = categoryType === selectedType;

        option.hidden = !isVisible;
        option.disabled = !isVisible;
      });

      if (
        selectedOption &&
        selectedOption.value &&
        selectedOption.dataset.categoryType !== selectedType
      ) {
        category.value = "";
      }
    }

    function handleAmountInput() {
      if (!amount) return;
      amount.value = formatAmount(amount.value);
    }

    operationType?.addEventListener("change", syncCategories);
    amount?.addEventListener("input", handleAmountInput);

    syncCategories();

    return () => {
      operationType?.removeEventListener("change", syncCategories);
      amount?.removeEventListener("input", handleAmountInput);
    };
  }, []);

  return null;
}
