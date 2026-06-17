type RequestWithRetryOptions = {
  url: string;
  init: RequestInit;
  label: string;
};

export async function requestWithRetry({
  url,
  init,
  label,
}: RequestWithRetryOptions) {
  const response = await fetch(url, init);

  if (response.status !== 429) {
    return response;
  }

  const text = await response.text().catch(() => "");

  throw new Error(`${label}: 429 Too Many Requests. ${text}`.trim());
}