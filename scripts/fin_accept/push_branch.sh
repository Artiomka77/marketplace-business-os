#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | awk -F= '/^password=/{print $2; exit}')
if [ -z "${TOKEN:-}" ]; then
  echo "NO_TOKEN" >&2
  exit 1
fi
echo "TOKEN_LEN=${#TOKEN}"
git push "https://x-access-token:${TOKEN}@github.com/Artiomka77/marketplace-business-os.git" \
  HEAD:build/fin-accept-images-20261027_180500
echo PUSH_OK
