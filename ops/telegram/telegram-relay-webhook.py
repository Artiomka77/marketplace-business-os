#!/usr/bin/env python3
import hmac
import http.server
import json
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = pathlib.Path("/root/avorofin-bot-test")
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

ENV_PATH = pathlib.Path("/opt/avorofin/.env.production")
LOG_PATH = LOG_DIR / "telegram-relay-webhook.log"

APP_WEBHOOK_URL = "http://127.0.0.1:3001/api/telegram/webhook"
HOST = "127.0.0.1"
PORT = 8092


def load_env(path: pathlib.Path) -> dict:
    env = {}
    if not path.exists():
        return env

    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]

        env[key] = value

    return env


ENV = load_env(ENV_PATH)

def _clean(value):
    return str(value or "").strip()

TELEGRAM_BOT_TOKEN = _clean(ENV.get("TELEGRAM_BOT_TOKEN", ""))
TELEGRAM_WEBHOOK_SECRET = _clean(ENV.get("TELEGRAM_WEBHOOK_SECRET", ""))
TELEGRAM_WEBHOOK_SECRET_PREVIOUS = _clean(ENV.get("TELEGRAM_WEBHOOK_SECRET_PREVIOUS", ""))


def _secret_eq(left, right):
    if not left or not right:
        return False
    a = left.encode("utf-8")
    b = right.encode("utf-8")
    if len(a) != len(b):
        hmac.compare_digest(a, a)
        return False
    return hmac.compare_digest(a, b)


def webhook_secret_accepted(incoming):
    if not TELEGRAM_WEBHOOK_SECRET:
        return False
    if _secret_eq(incoming, TELEGRAM_WEBHOOK_SECRET):
        return True
    if TELEGRAM_WEBHOOK_SECRET_PREVIOUS and _secret_eq(incoming, TELEGRAM_WEBHOOK_SECRET_PREVIOUS):
        return True
    return False


def log(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n"
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line)


def normalize_telegram_payload(payload: dict) -> dict:
    normalized = {}

    for key, value in payload.items():
        if key == "method" or value is None:
            continue

        if isinstance(value, bool):
            normalized[key] = "true" if value else "false"
        elif isinstance(value, (dict, list)):
            normalized[key] = json.dumps(value, ensure_ascii=False)
        else:
            normalized[key] = str(value)

    return normalized


def telegram_api(method: str, payload: dict, timeout: int = 15) -> bool:
    if not TELEGRAM_BOT_TOKEN:
        log(f"telegram_api_skip method={method} reason=no_token")
        return False

    if not method or not method.replace("_", "").isalnum():
        log(f"telegram_api_skip method={method!r} reason=invalid_method")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}"
    data = urllib.parse.urlencode(normalize_telegram_payload(payload)).encode("utf-8")

    try:
        req = urllib.request.Request(url, data=data, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(700).decode("utf-8", errors="replace")
            log(f"telegram_api_ok method={method} status={resp.status} body={body}")
            return 200 <= int(resp.status) < 300
    except urllib.error.HTTPError as exc:
        body = exc.read(700).decode("utf-8", errors="replace")
        log(f"telegram_api_http_error method={method} status={exc.code} body={body}")
        return False
    except Exception as exc:
        log(f"telegram_api_error method={method} error={type(exc).__name__}: {exc}")
        return False


def early_acknowledge(update: dict) -> None:
    callback = update.get("callback_query")
    if not isinstance(callback, dict):
        return

    callback_id = callback.get("id")
    if not callback_id:
        return

    data = str(callback.get("data") or "")
    text = "Принято. Готовлю отчёт, пришлю отдельным сообщением." if "report" in data.lower() else ""

    payload = {
        "callback_query_id": callback_id,
        "show_alert": False,
    }

    if text:
        payload["text"] = text

    telegram_api("answerCallbackQuery", payload, timeout=5)


def execute_app_webhook_response(response_text: str, update_id: str) -> None:
    text = (response_text or "").strip()
    if not text:
        log(f"app_response_empty update_id={update_id}")
        return

    try:
        data = json.loads(text)
    except Exception as exc:
        log(f"app_response_parse_skip update_id={update_id} error={type(exc).__name__} preview={text[:500]}")
        return

    if not isinstance(data, dict):
        log(f"app_response_skip update_id={update_id} reason=not_object")
        return

    method = data.get("method")
    if not isinstance(method, str) or not method:
        log(f"app_response_no_method update_id={update_id} keys={','.join(sorted(map(str, data.keys())))}")
        return

    # Callback queries are already answered immediately by relay.
    # Sending the same answerCallbackQuery later often produces Telegram 400.
    if method == "answerCallbackQuery":
        log(f"app_response_method_skip update_id={update_id} method=answerCallbackQuery reason=already_acked")
        return

    ok = telegram_api(method, data, timeout=20)
    log(f"app_response_method_exec update_id={update_id} method={method} ok={ok}")


def forward_to_app(body: bytes, update_id: str) -> None:
    started = time.time()

    try:
        headers = {
            "Content-Type": "application/json",
            "X-Telegram-Bot-Api-Secret-Token": TELEGRAM_WEBHOOK_SECRET,
        }

        req = urllib.request.Request(
            APP_WEBHOOK_URL,
            data=body,
            headers=headers,
            method="POST",
        )

        with urllib.request.urlopen(req, timeout=900) as resp:
            response_bytes = resp.read(2_000_000)
            response_body = response_bytes.decode("utf-8", errors="replace")
            elapsed = time.time() - started
            preview = response_body[:1000]
            log(
                f"forward_ok update_id={update_id} status={resp.status} "
                f"seconds={elapsed:.3f} response={preview}"
            )
            execute_app_webhook_response(response_body, update_id)

    except urllib.error.HTTPError as exc:
        body_text = exc.read(1000).decode("utf-8", errors="replace")
        elapsed = time.time() - started
        log(
            f"forward_http_error update_id={update_id} status={exc.code} "
            f"seconds={elapsed:.3f} response={body_text}"
        )

    except Exception as exc:
        elapsed = time.time() - started
        log(
            f"forward_error update_id={update_id} seconds={elapsed:.3f} "
            f"error={type(exc).__name__}: {exc}"
        )


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "AvoroFinTelegramRelay/1.1"

    def log_message(self, fmt, *args):
        log("http " + fmt % args)

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/healthz"):
            self.send_json(200, {"ok": True, "service": "avorofin-telegram-relay", "version": "1.1"})
            return

        self.send_json(200, {"ok": True, "service": "avorofin-telegram-relay", "version": "1.1"})

    def do_POST(self):
        if not self.path.startswith("/api/telegram/webhook"):
            self.send_json(404, {"ok": False, "error": "not_found"})
            return

        incoming_secret = self.headers.get("X-Telegram-Bot-Api-Secret-Token", "") or ""

        if not webhook_secret_accepted(incoming_secret):
            log("reject invalid_secret")
            self.send_json(403, {"ok": False, "error": "invalid_secret"})
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0

        body = self.rfile.read(length)

        update_id = "unknown"

        try:
            update = json.loads(body.decode("utf-8"))
            update_id = str(update.get("update_id", "unknown"))
        except Exception as exc:
            update = {}
            log(f"json_parse_error error={type(exc).__name__}: {exc}")

        try:
            early_acknowledge(update)
        except Exception as exc:
            log(f"early_ack_error update_id={update_id} error={type(exc).__name__}: {exc}")

        thread = threading.Thread(
            target=forward_to_app,
            args=(body, update_id),
            daemon=True,
        )
        thread.start()

        self.send_json(200, {"ok": True, "queued": True})


def main():
    if not TELEGRAM_BOT_TOKEN:
        log("startup_warning TELEGRAM_BOT_TOKEN empty")

    if not TELEGRAM_WEBHOOK_SECRET:
        log("startup_warning TELEGRAM_WEBHOOK_SECRET empty")

    log(f"startup host={HOST} port={PORT} app={APP_WEBHOOK_URL} version=1.1")
    server = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
