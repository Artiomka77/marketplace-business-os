import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { normalizeWbFinance } from "@/lib/import/normalizers/wbFinanceNormalizer";

type CompanyRow = {
  id: string;
  name: string;
};

type WbFinanceReport = {
  reportId?: number | string;
  sellerFinanceName?: string;
  dateFrom?: string;
  dateTo?: string;
  reportType?: number | string;
  retailAmountSum?: string | number;
  forPaySum?: string | number;
  deliveryServiceSum?: string | number;
  paidStorageSum?: string | number;
  paidAcceptanceSum?: string | number;
  deductionSum?: string | number;
  penaltySum?: string | number;
  bankPaymentSum?: string | number;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Неизвестная ошибка";
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 35);

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
  };
}

function mapWbFinanceApiRows(rows: WbFinanceReport[]) {
  return rows.map((row) => ({
    "№ отчета": row.reportId ? String(row.reportId) : "",
    "Юридическое лицо": row.sellerFinanceName ?? "",
    "Дата начала": row.dateFrom ?? "",
    "Дата конца": row.dateTo ?? "",
    "Тип отчета": row.reportType ? String(row.reportType) : "API WB Finance",

    Продажа: row.retailAmountSum ?? "",
    "К перечислению за товар": row.forPaySum ?? "",
    "Стоимость логистики": row.deliveryServiceSum ?? "",
    "Стоимость хранения": row.paidStorageSum ?? "",
    "Стоимость операций на приемке": row.paidAcceptanceSum ?? "",
    "Прочие удержания/выплаты": row.deductionSum ?? "",
    "Общая сумма штрафов": row.penaltySum ?? "",
    "Итого к оплате": row.bankPaymentSum ?? "",
  }));
}

async function fetchWbFinanceReports(token: string) {
  const { dateFrom, dateTo } = getDefaultPeriod();

  const response = await fetch(
    "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list",
    {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateFrom,
        dateTo,
        limit: 100,
        offset: 0,
        period: "weekly",
      }),
      cache: "no-store",
    }
  );

  if (response.status === 204) {
    return {
      dateFrom,
      dateTo,
      rows: [] as WbFinanceReport[],
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Finance API: ${response.status} ${text}`.trim());
  }

  const json = await response.json();

  if (!Array.isArray(json)) {
    throw new Error("WB Finance API вернул неожиданный формат ответа");
  }

  return {
    dateFrom,
    dateTo,
    rows: json as WbFinanceReport[],
  };
}

async function findCompany(companyId: string) {
  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "id" = ${companyId}
    limit 1
  `;

  return companies[0] ?? null;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  const company = await findCompany(companyId);

  if (!company) {
    redirect("/settings/api-connections");
  }

  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
  });

  if (!connection?.wbToken) {
    await prisma.marketplaceApiConnection.upsert({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "WB",
        },
      },
      create: {
        companyId,
        marketplace: "WB",
        status: "ERROR",
        lastError: "WB token не сохранён",
      },
      update: {
        status: "ERROR",
        lastError: "WB token не сохранён",
      },
    });

    redirect("/settings/api-connections");
  }

  try {
    const result = await fetchWbFinanceReports(connection.wbToken);
    const normalizedRows = mapWbFinanceApiRows(result.rows);

    const importSession = await prisma.importSession.create({
      data: {
        fileName: `WB Finance API ${company.name} ${result.dateFrom} - ${result.dateTo}`,
        reportType: "WB_FINANCE",
        marketplace: "WILDBERRIES",
        companyName: company.name,
        rowsCount: normalizedRows.length,
        previewJson: normalizedRows.slice(0, 10),
        sheetName: "WB Finance API",
        headerRow: 1,
        status: "SUCCESS",
      },
    });

    const normalizeResult = await normalizeWbFinance(
      normalizedRows,
      importSession.id,
      company.name
    );

    await prisma.marketplaceApiConnection.update({
      where: {
        id: connection.id,
      },
      data: {
        status: "CONNECTED",
        lastSyncAt: new Date(),
        lastError: null,
      },
    });

    await prisma.importSession.update({
      where: {
        id: importSession.id,
      },
      data: {
        rowsCount: normalizeResult.savedRows,
      },
    });
  } catch (error) {
    await prisma.marketplaceApiConnection.update({
      where: {
        id: connection.id,
      },
      data: {
        status: "ERROR",
        lastError: getErrorMessage(error).slice(0, 1000),
      },
    });
  }

  redirect("/settings/api-connections");
}