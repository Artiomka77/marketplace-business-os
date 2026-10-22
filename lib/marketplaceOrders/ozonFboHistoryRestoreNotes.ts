/**
 * FIN_CLOSE — documented source of restored Ozon order history (ИП Лебедева).
 *
 * Source of truth for Jan–Jun 2026 gap fill:
 *   Ozon Seller API POST /v3/posting/fbo/list
 *   (analytics_data + financial_data; cursor pagination, limit ≤ 100)
 *
 * Semantics written to MarketplaceDailyOrderStat:
 *   ALL postings by order_date (analytics_data.order_date), including cancelled.
 *   rawJson.finCloseRestore = "ALL_ORDERS_INCL_CANCEL_20261022"
 *   rawJson.semantics = "orders_placed_all_statuses_by_order_date"
 *
 * Why not delivered-only:
 *   App canonical metric is Analytics ordered_units + revenue (orders placed).
 *   On Aug–Oct overlap, FBO all_incl_cancel MAE≈0.71 vs delivered MAE≈8.
 *   Archive count: 3187 postings = 1600 delivered + 1587 cancelled.
 *
 * Accuracy limit vs Analytics API:
 *   FBO list is a posting-level proxy, not a byte-identical Analytics series.
 *   Small day-level deltas remain (qty/price/timing). Do not fudge sums to match.
 *   Analytics /v1/analytics/data is preferred when the ~3-month window allows it;
 *   FBO restore is only the historical backfill where Analytics is unavailable.
 *
 * FBS: empty for this cabinet in the restored window (not used).
 */
export const OZON_FBO_HISTORY_RESTORE = {
  company: "ИП Лебедева",
  marketplace: "OZON",
  apiPath: "/v3/posting/fbo/list",
  restoreTag: "ALL_ORDERS_INCL_CANCEL_20261022",
  windowHalfOpen: { from: "2026-01-01", toExclusive: "2026-06-21" },
  postingCounts: { total: 3187, delivered: 1600, cancelled: 1587 },
  overlapMaeNote:
    "Analytics qty closest to FBO all_incl_cancel (MAE≈0.71), not delivered (MAE≈8)",
} as const;
