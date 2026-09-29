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

export function getTelegramAllowedChatIds() {
  return String(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
