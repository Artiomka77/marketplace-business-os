export async function sendTelegramMessage(params: {
  chatId: string;
  text: string;
  replyMarkup?: Record<string, unknown>;
  /** Optional; omit for plain text (default). Use HTML only for Message2 photo links. */
  parseMode?: "HTML";
}) {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: params.chatId,
      text: params.text,
      disable_web_page_preview: true,
      ...(params.parseMode ? { parse_mode: params.parseMode } : {}),
      ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${text}`);
  }

  return response.json();
}

/** Send product photo by HTTPS URL; returns null on failure (caller may fallback to text). */
export async function sendTelegramPhoto(params: {
  chatId: string;
  photoUrl: string;
  caption?: string;
  replyMarkup?: Record<string, unknown>;
}): Promise<unknown | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) return null;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: params.chatId,
        photo: params.photoUrl,
        ...(params.caption ? { caption: params.caption.slice(0, 1024) } : {}),
        ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export function getTelegramAllowedChatIds() {
  return String(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
