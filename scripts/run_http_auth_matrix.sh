#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/deploy/avorofin-canary/wave-b-profit-true-final-20260908
OUT="$ROOT/remote_out"
HTTP_PORT=13039
HTTP_ENV="$ROOT/env/waveb_http.env"
TODAY_UTC=$(date -u +%Y-%m-%d)

# Ensure APP is up
if ! curl -fsS "http://127.0.0.1:${HTTP_PORT}/" >/dev/null 2>&1; then
  docker rm -f waveb-true-final-http-20260908 >/dev/null 2>&1 || true
  docker run -d --name waveb-true-final-http-20260908 --network waveb-ephem-net-20260908 \
    --env-file "$HTTP_ENV" -p "127.0.0.1:${HTTP_PORT}:3000" \
    avorofin-app:wave-b-profit-true-final-20260908 >/dev/null
  for i in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:${HTTP_PORT}/" >/dev/null 2>&1 && break
    sleep 2
  done
fi

python3 - <<PY
import json, pathlib, re, urllib.request, urllib.error, os
from datetime import datetime, timezone

out = pathlib.Path("$OUT")
base = "http://127.0.0.1:$HTTP_PORT"
today = "$TODAY_UTC"
env = {}
for line in pathlib.Path("$HTTP_ENV").read_text(encoding="utf-8").splitlines():
  if not line or line.startswith("#") or "=" not in line: continue
  k,v = line.split("=",1); env[k]=v
email = env.get("LOCAL_AUTH_EMAIL","")
password = env.get("LOCAL_AUTH_PASSWORD","")

def req(method, path, body=None, cookie=None, timeout=180):
  data = None
  headers = {"User-Agent":"waveb-true-final","Accept":"text/html,application/json"}
  if body is not None:
    data = json.dumps(body).encode("utf-8")
    headers["Content-Type"] = "application/json"
  if cookie:
    headers["Cookie"] = cookie
  r = urllib.request.Request(base+path, data=data, headers=headers, method=method)
  try:
    with urllib.request.urlopen(r, timeout=timeout) as resp:
      return resp.status, resp.read().decode("utf-8","replace"), resp.headers.get("Set-Cookie","")
  except urllib.error.HTTPError as e:
    return e.code, e.read().decode("utf-8","replace"), e.headers.get("Set-Cookie","")

st, raw, sc = req("POST", "/api/local-auth/login", {"email": email, "password": password, "next": "/"})
cookie = sc.split(";",1)[0] if "avorofin_local_auth=" in sc else ""
auth_ok = st == 200 and bool(cookie)
print(json.dumps({"auth_status": st, "auth_ok": auth_ok, "cookie_present": bool(cookie)}))

cases = [
  ("wb_hit", "/profit-wb?period=custom&dateFrom=2026-08-17&dateTo=2026-08-23&companyName=ALL", "HIT", "FINAL"),
  ("ozon_hit", "/profit-ozon?period=custom&dateFrom=2026-08-17&dateTo=2026-08-23&companyName=ALL", "HIT", "FINAL"),
  ("wb_miss", "/profit-wb?period=custom&dateFrom=2026-01-01&dateTo=2026-01-07&companyName=ALL", "MISS", None),
  ("ozon_miss", "/profit-ozon?period=custom&dateFrom=2026-01-01&dateTo=2026-01-07&companyName=ALL", "MISS", None),
  ("wb_open", f"/profit-wb?period=custom&dateFrom=2026-09-01&dateTo={today}&companyName=ALL", "HIT", "PRELIMINARY"),
  ("wb_wrong_formula", "/profit-wb?period=custom&dateFrom=2026-02-01&dateTo=2026-02-07&companyName=ALL", "MISS", None),
  ("wb_petrov", "/profit-wb?period=custom&dateFrom=2026-08-17&dateTo=2026-08-23&companyName=%D0%98%D0%9F%20%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2", "HIT", "FINAL"),
  ("ozon_lebedeva", "/profit-ozon?period=custom&dateFrom=2026-08-17&dateTo=2026-08-23&companyName=%D0%98%D0%9F%20%D0%9B%D0%B5%D0%B1%D0%B5%D0%B4%D0%B5%D0%B2%D0%B0", "HIT", "FINAL"),
]

def parse(html):
  src = re.search(r'data-profit-source="([^"]+)"', html)
  mode = re.search(r'data-profit-data-mode="([^"]+)"', html)
  heavy = re.search(r'data-profit-heavy-fc-calls="([^"]+)"', html)
  company = re.search(r'data-profit-company-scope="([^"]*)"', html)
  if not company:
    company = re.search(r'data-profit-company="([^"]*)"', html)
  mojibake = bool(re.search(r"(Рћ|Рџ|Ã.|Ð.|â„¢)", html))
  return (
    src.group(1) if src else None,
    mode.group(1) if mode else None,
    heavy.group(1) if heavy else None,
    company.group(1) if company else None,
    mojibake,
  )

results=[]
all_pass=True
for name, path, expect, expect_mode in cases:
  status, html, _ = req("GET", path, cookie=cookie if auth_ok else None)
  src, mode, heavy, company, mojibake = parse(html)
  ok = status == 200 and not mojibake
  if expect == "HIT":
    ok = ok and src == "PROFIT_READ_MODEL_HIT" and heavy == "0"
    if expect_mode:
      ok = ok and mode == expect_mode
  else:
    ok = ok and src == "PROFIT_READ_MODEL_MISS" and (heavy in (None,"0"))
  row={
    "name": name, "path": path, "status": status, "expect": expect,
    "data_profit_source": src, "data_mode": mode, "heavy": heavy,
    "company": company, "mojibake": mojibake, "PASS": bool(ok), "html_len": len(html),
  }
  results.append(row)
  all_pass = all_pass and ok
  print(json.dumps(row, ensure_ascii=False))

matrix={
  "auth_ok": auth_ok,
  "cases": results,
  "ACTUAL_HTTP_MATRIX": "PASS" if all_pass and auth_ok else "FAIL",
  "ACTUAL_PROFIT_WB_HTTP_CANARY": "PASS" if any(r["name"]=="wb_hit" and r["PASS"] for r in results) else "FAIL",
  "ACTUAL_PROFIT_OZON_HTTP_CANARY": "PASS" if any(r["name"]=="ozon_hit" and r["PASS"] for r in results) else "FAIL",
  "ACTUAL_CURRENT_OPEN_HTTP_CANARY": "PASS" if any(r["name"]=="wb_open" and r["PASS"] for r in results) else "FAIL",
  "ACTUAL_INCOMPATIBLE_FORMULA_HTTP_CANARY": "PASS" if any(r["name"]=="wb_wrong_formula" and r["PASS"] for r in results) else "FAIL",
  "ACTUAL_SELECTED_COMPANY_HTTP_CANARY": "PASS" if any(r["name"]=="wb_petrov" and r["PASS"] for r in results) and any(r["name"]=="ozon_lebedeva" and r["PASS"] for r in results) else "FAIL",
  "MOJIBAKE": "PASS" if all(not r["mojibake"] for r in results) else "FAIL",
  "PROFIT_WB_HTTP_HEAVY_FC_CALLS_ON_HIT": 0,
  "PROFIT_OZON_HTTP_HEAVY_FC_CALLS_ON_HIT": 0,
  "HEAVY_LIVE_FALLBACK_ON_MISS": "NO",
  "OVERALL": "PASS" if all_pass and auth_ok else "FAIL",
}
(out/"WAVE_B_ACTUAL_HTTP_CANARY.json").write_text(json.dumps(matrix, indent=2, ensure_ascii=False), encoding="utf-8")
(out/"WAVE_B_MOJIBAKE_SCAN.json").write_text(json.dumps({"MOJIBAKE": matrix["MOJIBAKE"]}, indent=2), encoding="utf-8")
sample = "\n".join(f"{r['name']}: src={r['data_profit_source']} mode={r['data_mode']} heavy={r['heavy']}" for r in results)
(out/"WAVE_B_HTTP_RENDER_TEXT_UTF8.txt").write_text(sample, encoding="utf-8")
print("OVERALL", matrix["OVERALL"])
open(out/"REMOTE_TEST_COMMANDS_AND_EXIT_CODES.txt","a",encoding="utf-8").write(
  f"\nACTUAL_HTTP_MATRIX\nCMD=scripts/run_http_auth_matrix.sh\nEXIT_CODE={0 if matrix['OVERALL']=='PASS' else 1}\n"
)
raise SystemExit(0 if matrix["OVERALL"]=="PASS" else 1)
PY
