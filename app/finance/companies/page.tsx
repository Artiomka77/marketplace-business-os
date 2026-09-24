import { redirect } from "next/navigation";

export default function FinanceCompaniesRedirectPage() {
  redirect("/settings/companies");
}