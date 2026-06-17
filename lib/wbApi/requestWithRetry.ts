type RequestWithRetryOptions = {
  url: string;
  init: RequestInit;
  label: string;
  maxAttempts?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRY_DELAYS = [
  60000,  // 1 минута
  120000, // 2 минуты
  180000, // 3 минуты
  240000, // 4 минуты
];

export async function requestWithRetry({
  url,
  init,
  label,
  maxAttempts = 5,
}: RequestWithRetryOptions) {
  let response = await fetch(url, init);

  if (response.status !== 429) {
    return response;
  }

  for (let i = 0; i < RETRY_DELAYS.length; i++) {
    await sleep(RETRY_DELAYS[i]);

    response = await fetch(url, init);

    if (response.status !== 429) {
      return response;
    }
  }

  const text = await response.text().catch(() => "");

  throw new Error(
    `${label}: 429 Too Many Requests after retries. ${text}`.trim()
  );
}