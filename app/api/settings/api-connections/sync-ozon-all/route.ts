import { redirect } from "next/navigation";

import { syncOzonAll } from "@/lib/ozon/syncOzon";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  await syncOzonAll(companyId);

  redirect("/settings/api-connections");
}