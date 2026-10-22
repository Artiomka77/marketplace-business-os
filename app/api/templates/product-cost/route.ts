import { NextResponse } from "next/server";

import { buildProductCostTemplateBuffer } from "@/lib/import/productCostTemplate";

export const dynamic = "force-dynamic";

export async function GET() {
  const buffer = await buildProductCostTemplateBuffer();

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="product_cost_template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
