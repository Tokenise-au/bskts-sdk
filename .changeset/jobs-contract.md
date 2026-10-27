---
"@bskts/sdk": patch
---

`jobs()` keeps the API's `vaults` count, which the schema used to drop. The vendored API contract now includes `GET /v1/jobs`, so a field the SDK drops from it fails a test.
