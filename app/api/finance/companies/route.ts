import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

function toNumber(value: FormDataEntryValue | null, fallback = 0) {
  const number = Number(
    String(value ?? "")
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(number) ? number : fallback;
}

export async function POST(request: Request) {
  const formData = await request.formData();

  const id = String(formData.get("id") ?? "").trim();
  const oldName = String(formData.get("oldName") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  const legalName = String(formData.get("legalName") ?? "").trim() || null;
  const inn = String(formData.get("inn") ?? "").trim() || null;
  const ogrnIp = String(formData.get("ogrnIp") ?? "").trim() || null;
  const taxSystem =
    String(formData.get("taxSystem") ?? "").trim() || "УСН Доходы";
  const usnRate = toNumber(
    formData.get("usnRate") ?? formData.get("incomeTaxRate"),
    1
  );
  const vatRate = toNumber(formData.get("vatRate"), 5);
  const isActive = formData.get("isActive") === "on";

  if (!name) {
    return NextResponse.redirect(new URL("/settings/companies", request.url));
  }

  await prisma.$transaction(async (tx) => {
    if (id) {
      await tx.$executeRaw`
        update "Company"
        set
          "name" = ${name},
          "legalName" = ${legalName},
          "inn" = ${inn},
          "ogrnIp" = ${ogrnIp},
          "taxSystem" = ${taxSystem},
          "usnRate" = ${usnRate},
          "incomeTaxRate" = ${usnRate},
          "vatRate" = ${vatRate},
          "isActive" = ${isActive},
          "updatedAt" = now()
        where "id" = ${id}
      `;
    } else {
      const newId = `company_${crypto.randomUUID()}`;

      await tx.$executeRaw`
        insert into "Company" (
          "id",
          "name",
          "legalName",
          "inn",
          "ogrnIp",
          "taxSystem",
          "usnRate",
          "incomeTaxRate",
          "vatRate",
          "isActive",
          "createdAt",
          "updatedAt"
        )
        values (
          ${newId},
          ${name},
          ${legalName},
          ${inn},
          ${ogrnIp},
          ${taxSystem},
          ${usnRate},
          ${usnRate},
          ${vatRate},
          ${isActive},
          now(),
          now()
        )
      `;
    }

    if (id && oldName && oldName !== name) {
      await tx.financeAccount.updateMany({
        where: { companyName: oldName },
        data: { companyName: name },
      });

      await tx.loan.updateMany({
        where: { companyName: oldName },
        data: { companyName: name },
      });

      await tx.financeTransaction.updateMany({
        where: { companyName: oldName },
        data: { companyName: name },
      });
    }
  });

  revalidatePath("/finance");
  revalidatePath("/settings/companies");
  revalidatePath("/finance/companies");
  revalidatePath("/finance/accounts");
  revalidatePath("/finance/loans");
  revalidatePath("/finance/operations");

  return NextResponse.redirect(new URL("/settings/companies", request.url));
}