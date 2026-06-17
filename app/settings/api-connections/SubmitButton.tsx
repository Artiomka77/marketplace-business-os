"use client";

import { useFormStatus } from "react-dom";

type SubmitButtonProps = {
  children: React.ReactNode;
  pendingText: string;
  name?: string;
  value?: string;
  formAction?: string;
  formMethod?: "GET" | "POST";
  className: string;
};

export default function SubmitButton({
  children,
  pendingText,
  name,
  value,
  formAction,
  formMethod,
  className,
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <button
      name={name}
      value={value}
      formAction={formAction}
      formMethod={formMethod}
      disabled={pending}
      className={`${className} inline-flex items-center justify-center gap-2 transition active:scale-95 disabled:cursor-wait disabled:opacity-60`}
    >
      {pending && (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {pending ? pendingText : children}
    </button>
  );
}