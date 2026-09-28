import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { normalizeOzonFinance } from "@/lib/import/normalizers/ozonFinanceNormalizer";

type CompanyRow = {
  id: string;
  name: string;
};

type OzonFinanceOperation = {
  operation_id?: number | string;
  operation_type?: string;
  operation_date?: string;
  operation_type_name?: string;
  accruals_for_sale?: number;
  sale_commission?: number;
  amount?: number;
  delivery_charge?: number;
  return_delivery_charge?: number;
  type?: string;
  posting?: {
    posting_number?: string;
  };
  items?: {
    sku?: number | string;
    name?: string;
  }[];
  services?: {
    name?: string;
    price?: number;
  }[];
};

type OzonFinanceResponse = {
  result?: {
    operations?: OzonFinanceOperation[];
    page_count?: number;
    row_count?: number;
  };
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 14);

  return {
    dateFromText: formatDateOnly(dateFrom),
    dateToText: formatDateOnly(dateTo),
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isNaN(value) ? 0 : value;
  }

  const number = Number(value ?? 0);
  return Number.isNaN(number) ? 0 : number;
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

async function fetchOzonFinanceOperations(
  clientId: string,
  apiKey: string,
  dateFromText: string,
  dateToText: string
) {
  const allOperations: OzonFinanceOperation[] = [];
  const pageSize = 1000;
  let page = 1;
  let pageCount = 1;

  while (page <= pageCount) {
    const response = await fetch(
      "https://api-seller.ozon.ru/v3/finance/transaction/list",
      {
        method: "POST",
        headers: {
          "Client-Id": clientId,
          "Api-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            date: {
              from: `${dateFromText}T00:00:00.000Z`,
              to: `${dateToText}T23:59:59.999Z`,
            },
            operation_type: [],
            posting_number: "",
            transaction_type: "all",
          },
          page,
          page_size: pageSize,
        }),
        cache: "no-store",
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ozon Finance API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as OzonFinanceResponse;

    const operations = json.result?.operations ?? [];
    pageCount = json.result?.page_count ?? 1;

    allOperations.push(...operations);

    page += 1;
  }

  return allOperations;
}

function getServiceSums(operation: OzonFinanceOperation) {
  let logisticsCost = toNumber(operation.delivery_charge);
  let reverseLogisticsCost = toNumber(operation.return_delivery_charge);

  for (const service of operation.services ?? []) {
    const serviceName = String(service.name ?? "");
    const price = toNumber(service.price);

    const isReverseLogistics =
      serviceName.includes("ReturnFlowLogistic") ||
      serviceName.includes("RedistributionReturns") ||
      serviceName.includes("Return") ||
      serviceName.includes("Returns");

    const isDirectLogistics =
      serviceName.includes("DirectFlowLogistic") ||
      serviceName.includes("LastMile") ||
      serviceName.includes("Courier") ||
      serviceName.includes("Logistic");

    if (isReverseLogistics) {
      reverseLogisticsCost += price;
      continue;
    }

    if (isDirectLogistics) {
      logisticsCost += price;
    }
  }

  return {
    logisticsCost,
    reverseLogisticsCost,
  };
}

function divideAmount(value: unknown, divisor: number) {
  const number = toNumber(value);

  if (divisor <= 1) {
    return number;
  }

  return number / divisor;
}

function mapOzonFinanceRows(operations: OzonFinanceOperation[]) {
  const rows: Record<string, unknown>[] = [];

  for (const operation of operations) {
    const items = operation.items?.length ? operation.items : [null];
    const itemCount = items.length;
    const { logisticsCost, reverseLogisticsCost } = getServiceSums(operation);

    for (const item of items) {
      rows.push({
        "Дата начисления": operation.operation_date ?? "",
        "Тип операции":
          operation.operation_type_name ?? operation.operation_type ?? "",

        SKU: item?.sku ? String(item.sku) : "",
        Артикул: "",

        Количество: item ? 1 : "",

        "Сумма продаж": divideAmount(operation.accruals_for_sale, itemCount),
        "Комиссия Ozon": divideAmount(operation.sale_commission, itemCount),
        Логистика: divideAmount(logisticsCost, itemCount),
        "Обратная логистика": divideAmount(reverseLogisticsCost, itemCount),
        Итого: divideAmount(operation.amount, itemCount),
      });
    }
  }

  return rows;
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
        marketplace: "OZON",
      },
    },
  });

  if (!connection?.ozonClientId || !connection?.ozonApiKey) {
    await prisma.marketplaceApiConnection.upsert({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "OZON",
        },
      },
      create: {
        companyId,
        marketplace: "OZON",
        status: "ERROR",
        lastError: "Ozon Client-Id или Api-Key не сохранены",
      },
      update: {
        status: "ERROR",
        lastError: "Ozon Client-Id или Api-Key не сохранены",
      },
    });

    redirect("/settings/api-connections");
  }

  try {
    const { dateFromText, dateToText } = getDefaultPeriod();

    const operations = await fetchOzonFinanceOperations(
      connection.ozonClientId,
      connection.ozonApiKey,
      dateFromText,
      dateToText
    );

    const rows = mapOzonFinanceRows(operations);

    const importSession = await prisma.importSession.create({
      data: {
        fileName: `Ozon API Finance ${company.name} ${dateFromText} - ${dateToText}`,
        reportType: "OZON_FINANCE",
        marketplace: "OZON",
        companyName: company.name,
        rowsCount: rows.length,
        previewJson: rows.slice(0, 10) as any,
        sheetName: "Ozon Finance API",
        headerRow: 1,
        status: "SUCCESS",
      },
    });

    const normalizeResult = await normalizeOzonFinance(
      rows,
      importSession.id,
      company.name
    );

    await prisma.importSession.update({
      where: {
        id: importSession.id,
      },
      data: {
        rowsCount: normalizeResult.savedRows,
      },
    });

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
  } catch (error) {
    await prisma.marketplaceApiConnection.update({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "OZON",
        },
      },
      data: {
        status: "ERROR",
        lastError: getErrorMessage(error).slice(0, 1000),
      },
    });
  }

  redirect("/settings/api-connections");
}