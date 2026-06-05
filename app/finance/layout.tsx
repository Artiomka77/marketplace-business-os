import FinanceNav from "@/components/finance/FinanceNav";

export default function FinanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <FinanceNav />
      {children}
    </>
  );
}