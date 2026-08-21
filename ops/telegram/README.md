AvoroFin Telegram inbound relay

This is the Telegram-facing webhook receiver used on the Telegram VPS.

Current topology:
- Caddy terminates TLS for 64-188-63-133.sslip.io
- this process listens on 127.0.0.1:8092
- it forwards authorized updates to the local app at 127.0.0.1:3001/api/telegram/webhook

Auth:
- header X-Telegram-Bot-Api-Secret-Token
- TELEGRAM_WEBHOOK_SECRET is required (fail-closed)
- TELEGRAM_WEBHOOK_SECRET_PREVIOUS is optional and only honored when SET
- secrets come from environment / env-file, never from this source

Do not put credentials in this file or in Caddyfile.
