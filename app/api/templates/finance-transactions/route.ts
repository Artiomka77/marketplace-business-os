import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";

function createFinanceTransactionsTemplate() {
  const headers = [
    "Дата",
    "Дата обязательства",
    "Компания",
    "Тип операции",
    "Статья",
    "Подстатья",
    "Счет",
    "Сумма",
    "Контрагент",
    "Проект",
    "Комментарий",
    "Внутренний перевод",
  ];

  const rows = [
    [
      "22.06.2026",
      "22.06.2026",
      "ИП Петров",
      "Расход",
      "Оплата тела кредита",
      "",
      "Сбербанк карта",
      17792,
      "Банк",
      "Кредиты",
      "Платёж по кредиту",
      "Нет",
    ],
    [
      "22.06.2026",
      "22.06.2026",
      "ИП Петров",
      "Расход",
      "Фулфилмент",
      "",
      "Сбербанк карта",
      12500,
      "Поставщик",
      "WB/Ozon",
      "Упаковка и обработка",
      "Нет",
    ],
    [
      "22.06.2026",
      "22.06.2026",
      "ИП Лебедева",
      "Поступление",
      "Внесение собственника",
      "",
      "Расчетный счет",
      50000,
      "Собственник",
      "Оборотка",
      "Пополнение оборотных средств",
      "Нет",
    ],
  ];

  const guideRows = [
    ["Поле", "Как заполнять"],
    ["Дата", "Дата фактической оплаты или поступления. Формат: ДД.ММ.ГГГГ."],
    ["Дата обязательства", "Можно оставить пустой."],
    ["Компания", "Можно оставить пустой, тогда используется компания, выбранная при импорте."],
    ["Тип операции", "Поступление, Расход, Перевод, Финансирование, Вывод собственника."],
    ["Статья", "Финансовая статья из справочника."],
    ["Сумма", "Положительное число. Знак минус ставить не нужно."],
    ["Внутренний перевод", "Да или Нет."],
  ];

  const workbook = XLSX.utils.book_new();
  const operationsSheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const guideSheet = XLSX.utils.aoa_to_sheet(guideRows);

  operationsSheet["!cols"] = [
    { wch: 14 },
    { wch: 18 },
    { wch: 16 },
    { wch: 20 },
    { wch: 28 },
    { wch: 20 },
    { wch: 20 },
    { wch: 14 },
    { wch: 24 },
    { wch: 20 },
    { wch: 36 },
    { wch: 18 },
  ];

  guideSheet["!cols"] = [{ wch: 24 }, { wch: 84 }];

  XLSX.utils.book_append_sheet(workbook, operationsSheet, "Операции");
  XLSX.utils.book_append_sheet(workbook, guideSheet, "Справочник");

  return workbook;
}

export async function GET() {
  const workbook = createFinanceTransactionsTemplate();
  const buffer = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
  });

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="finance_transactions_template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
