import { redirect } from "next/navigation";

import { syncWbAll } from "@/lib/wb/syncWb";

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

  await syncWbAll(companyId);

  redirect("/settings/api-connections");
}