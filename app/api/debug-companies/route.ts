import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const companies = await prisma.$queryRaw`
    select "id", "name"
    from "Company"
    order by "name"
  `;

  return NextResponse.json({
    companies,
  });
}