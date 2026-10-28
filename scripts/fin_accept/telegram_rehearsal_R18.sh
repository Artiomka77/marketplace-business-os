#!/usr/bin/env bash
# Isolated Telegram cutover rehearsal with mock docker. No real sends.
set -euo pipefail
OUT="${1:?out dir}"
mkdir -p "$OUT/mockbin" "$OUT/logs"
MOCK="$OUT/mockbin"
: > "$OUT/logs/docker_calls.txt"
HEALTH_FILE="$OUT/health_code.txt"
echo 200 > "$HEALTH_FILE"

cat > "$MOCK/docker" <<'EOS'
#!/usr/bin/env bash
LOG="$(dirname "$0")/../logs/docker_calls.txt"
echo "docker $*" >> "$LOG"
cmd="$1"; shift || true
case "$cmd" in
  image)
    sub="$1"; shift || true
    if [[ "$sub" == inspect ]]; then
      echo "sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453"
      exit 0
    fi
    exit 0 ;;
  inspect)
    if [[ "$*" == *Config.Env* ]]; then
      echo "DATABASE_URL=postgresql://x:y@127.0.0.1:5432/x"
      echo "TELEGRAM_BOT_TOKEN=redacted"
      exit 0
    fi
    echo "ok"; exit 0 ;;
  tag) exit 0 ;;
  stop|rm) exit 0 ;;
  run)
    echo "cid_mock_telegram"
    exit 0 ;;
  *) exit 0 ;;
esac
EOS
chmod +x "$MOCK/docker"

cat > "$MOCK/curl" <<EOS
#!/usr/bin/env bash
code=\$(cat "$HEALTH_FILE")
echo -n "\$code"
exit 0
EOS
chmod +x "$MOCK/curl"

export PATH="$MOCK:$PATH"
NEW_IMAGE="avorofin-p0-cogs-telegram:20261014_tg_top_truth"
NEW_ID="sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453"

echo "=== rehearse image inspect BEFORE stop ==="
docker image inspect "$NEW_IMAGE" >/dev/null
got="$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE" 2>/dev/null || docker image inspect "$NEW_IMAGE")"
echo "image_id=$got"

echo "=== capture env ==="
docker inspect avorofin-telegram-app --format '{{range .Config.Env}}{{println .}}{{end}}' \
  > "$OUT/tg_env_captured.env"
chmod 600 "$OUT/tg_env_captured.env"

echo "=== tag rollback ==="
docker tag "$NEW_IMAGE" avorofin-p0-cogs-telegram:rollback_pre_c01

echo "=== stop/rm/run ==="
docker stop avorofin-telegram-app
docker rm avorofin-telegram-app
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --env-file "$OUT/tg_env_captured.env" -p 127.0.0.1:3001:3000 "$NEW_IMAGE"

echo "=== health (must succeed; no || true) ==="
code="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/)"
echo "health_code=$code"
case "$code" in
  200|302|307) echo "HEALTH_OK" ;;
  *) echo "HEALTH_FAIL code=$code"; exit 5 ;;
esac

echo "=== rollback rehearsal ==="
docker stop avorofin-telegram-app
docker rm avorofin-telegram-app
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --env-file "$OUT/tg_env_captured.env" -p 127.0.0.1:3001:3000 \
  avorofin-p0-cogs-telegram:rollback_pre_c01
code="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/)"
case "$code" in
  200|302|307) echo "ROLLBACK_HEALTH_OK" ;;
  *) echo "ROLLBACK_HEALTH_FAIL"; exit 6 ;;
esac

# Negative: bad health must fail
echo 500 > "$HEALTH_FILE"
set +e
code="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/)"
set -e
if [[ "$code" == "200" || "$code" == "302" || "$code" == "307" ]]; then
  echo "FAIL expected bad health"; exit 7
fi
echo "BAD_HEALTH_DETECTED code=$code"

python3 - <<PY
import json, pathlib
out=pathlib.Path(r"$OUT")
ev={
  "sendMessages": False,
  "imageIdExpected": "$NEW_ID",
  "healthOk": True,
  "rollbackHealthOk": True,
  "badHealthRejected": True,
  "dockerCalls": (out/"logs"/"docker_calls.txt").read_text(encoding="utf-8", errors="replace").splitlines(),
}
(out/"REHEARSAL_SUMMARY.json").write_text(json.dumps(ev, indent=2)+"\n", encoding="utf-8")
print("TELEGRAM_REHEARSAL_R18_OK")
PY
