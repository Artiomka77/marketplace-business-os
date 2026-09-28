# Wave B Strangler Binding

Reuses prior `STRANGLER_PLAN.md` (WB then Ozon).

## Feature flags
- `WAVE_B_PROFIT_READMODEL_FIRST=1` — ordinary HTTP uses read-model
- `WAVE_B_PROFIT_LIVE_FALLBACK=1` — explicit rollback only; default OFF

## Pages
- `app/profit-wb/page.tsx` — HIT render / MISS pending UI / no heavy FC on HIT
- `app/profit-ozon/page.tsx` — same contract

## Markers
`data-profit-source`, `data-profit-heavy-fc-calls`, `data-profit-formula`

## Production cutover (future only)
1. Producer/worker first
2. Seed closed-week scopes
3. Switch WB
4. Observe
5. Switch Ozon
