## 1. Implementation

- [x] 1.1 Add `pendingApprovals(principal, now, ttlMs)` to `SqliteJournal`
- [x] 1.2 Add `get_status` to the HTTP server (read scope, hidden when reads are denied) and wire it in `service.ts`

## 2. Verification

- [x] 2.1 Tests: pending listed with timings; decided, expired and other principals hidden; payload holds no nonce or state; scope required
- [x] 2.2 Lint, full tests, secret scan
- [x] 2.3 Mention the tool in the docs and update the roadmap
