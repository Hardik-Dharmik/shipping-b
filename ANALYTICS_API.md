# Analytics API

`GET /api/analytics` returns global, all-time dashboard counts.

Pass `Authorization: Bearer <token>` for an admin or an employee with the
`home` page permission. The existing server-to-server `x-admin-token` is also supported.
Regular user accounts cannot access this endpoint.

```json
{
  "success": true,
  "data": {
    "totalOrders": 120,
    "totalCustomers": 45,
    "pendingKyc": 8,
    "completedKyc": 30,
    "notStartedKyc": 7
  }
}
```

- `totalOrders`: all saved orders, including manual orders, across all statuses.
- `totalCustomers`: records in the shared customers directory, not registered user accounts.
- KYC counts: user accounts with `kyc_required = true`, grouped by their current
  `kyc_status`. Pending means submitted and awaiting review; not started is separate.

No query parameters are required. Counts use exact database counts without downloading
rows. Empty tables return zero. Counts are queried concurrently and may reflect slightly
different instants during writes.

Missing/invalid credentials return `401`; insufficient permissions return `403`.
If any count fails, the endpoint returns `500` with
`{"success":false,"error":"Unable to load analytics"}` instead of partial totals.
