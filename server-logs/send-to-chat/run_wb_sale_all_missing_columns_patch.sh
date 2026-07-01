#!/usr/bin/env bash
set -euo pipefail

cd /opt/avorofin

echo "Copy JS patch into container..."
docker cp /tmp/wb_sale_all_missing_columns_patch.js avorofin-app:/tmp/wb_sale_all_missing_columns_patch.js

echo "Run DB patch..."
docker compose --env-file .env.production exec -T app sh -lc 'cd /app && NODE_PATH=/app/node_modules node /tmp/wb_sale_all_missing_columns_patch.js'

echo "Restart app..."
docker compose --env-file .env.production restart app

sleep 5

echo "Check page from inside container..."
docker compose --env-file .env.production exec -T app node -e 'fetch("http://127.0.0.1:3000/profit-wb?dateFrom=2026-06-01&dateTo=2026-06-28&companyName=%D0%98%D0%9F%20%D0%9F%D0%B5%D1%82%D1%80%D0%BE%D0%B2").then(async r=>{console.log("PAGE_HTTP",r.status);console.log((await r.text()).slice(0,500));process.exit(r.ok?0:1);}).catch(e=>{console.error(e);process.exit(1);})'

echo "Recent app logs:"
docker compose --env-file .env.production logs --tail=80 app