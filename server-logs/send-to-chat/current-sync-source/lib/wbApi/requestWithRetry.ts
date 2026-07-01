type RequestWithRetryOptions = {
  url: string;
  init: RequestInit;
  label: string;
  timeoutMs?: number;
};

export async function requestWithRetry({
  url,
  init,
  label,
  timeoutMs = 30_000,
}: RequestWithRetryOptions) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (response.status !== 429) {
      return response;
    }

    const text = await response.text().catch(() => "");

    throw new Error(`${label}: 429 Too Many Requests. ${text}`.trim());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label}: timeout after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}