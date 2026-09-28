const { Client } = require("pg");

const client = new Client({ connectionString: process.env.DATABASE_URL });

const incomeCashOnlyNames = [
  "пришло на счет",
  "пришло на счёт",
  "поступило на счет",
  "поступило на счёт",
  "поступление на счет",
  "поступление на счёт",
  "зачисление на счет",
  "зачисление на счёт",
  "поступления от маркетплейсов",
  "выплата маркетплейса",
  "выплаты маркетплейса",
];

async function main() {
  await client.connect();

  console.log("[income-cash-only] start");

  const before = await client.query(
    `
    SELECT "id", "name", "categoryType", "parentName", "profitTreatment"
    FROM "FinanceCategory"
    WHERE lower(replace("name", 'ё', 'е')) = ANY($1::text[])
    ORDER BY "categoryType", "name"
    `,
    [incomeCashOnlyNames.map((name) => name.replaceAll("ё", "е"))]
  );

  console.log("[income-cash-only] before");
  console.table(before.rows);

  const update = await client.query(
    `
    UPDATE "FinanceCategory"
    SET "profitTreatment" = 'CASH_ONLY'
    WHERE lower(replace("name", 'ё', 'е')) = ANY($1::text[])
      AND upper(coalesce("categoryType", '')) = 'INCOME'
    RETURNING "id", "name", "categoryType", "parentName", "profitTreatment"
    `,
    [incomeCashOnlyNames.map((name) => name.replaceAll("ё", "е"))]
  );

  console.log("[income-cash-only] updated rows:", update.rowCount);
  console.table(update.rows);

  console.log("[income-cash-only] done");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => {});
  });
