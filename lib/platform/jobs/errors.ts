import {
  PLATFORM_ERROR_CLASSES,
  type PlatformErrorClass,
  type SafeJobErrorMetadata,
} from "./types";

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown error");
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(
      /(api[_-]?key|token|authorization|client[_-]?id|secret)\s*[:=]\s*["']?[^\s"']+/gi,
      "$1=[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9+/]{24,}={0,2}/g, "[redacted]")
    .slice(0, 500);
}

export function classifyPlatformError(error: unknown): SafeJobErrorMetadata {
  const raw = getErrorMessage(error);
  const message = sanitizeErrorMessage(raw);
  const lower = message.toLowerCase();

  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("limited by global limiter")
  ) {
    return {
      errorClass: PLATFORM_ERROR_CLASSES.RATE_LIMIT,
      errorCode: "RATE_LIMIT",
      errorMessage: message,
    };
  }

  if (
    lower.includes("fail-closed") ||
    lower.includes("fail_closed") ||
    lower.includes("unknown ozon") ||
    lower.includes("unknown accrual type") ||
    lower.includes("unknown operation type") ||
    lower.includes("unexplained gross") ||
    lower.includes("coverage incomplete") ||
    lower.includes("sellerreturns") ||
    lower.includes("fingerprint conflict") ||
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return {
      errorClass: PLATFORM_ERROR_CLASSES.FAIL_CLOSED,
      errorCode: "FAIL_CLOSED",
      errorMessage: message,
    };
  }

  if (
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("socket hang up") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("504") ||
    lower.includes("500") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("canonical overlay") ||
    lower.includes("raw persist") ||
    lower.includes("raw write") ||
    lower.includes("connection reset")
  ) {
    return {
      errorClass: PLATFORM_ERROR_CLASSES.RETRYABLE,
      errorCode: "RETRYABLE",
      errorMessage: message,
    };
  }

  return {
    errorClass: PLATFORM_ERROR_CLASSES.FATAL,
    errorCode: "FATAL",
    errorMessage: message,
  };
}

export function statusForErrorClass(
  errorClass: PlatformErrorClass,
): "FAILED" | "RATE_LIMITED" | "FAIL_CLOSED" {
  if (errorClass === PLATFORM_ERROR_CLASSES.RATE_LIMIT) return "RATE_LIMITED";
  if (errorClass === PLATFORM_ERROR_CLASSES.FAIL_CLOSED) return "FAIL_CLOSED";
  return "FAILED";
}
