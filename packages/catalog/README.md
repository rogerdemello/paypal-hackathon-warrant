# @warrant/catalog

Product search and listing snapshots for the shopping agent.

- **`FixtureCatalog`**: a deterministic built-in catalog, so everything runs with `WARRANT_MODE=fixtures` and no API key.
- **`Channel3Catalog`**: product search against Channel3 (`POST /v1/search`, `GET /v1/products/{id}`, `x-api-key`). Written from the public documentation and unit tested with a fake `fetch`; **not yet run against the real API**. The optional response fields are read defensively and the field names marked `[spike]` in `src/channel3.ts` need confirming against a real response.
- **Listing snapshots**: a snapshot is hashed (`hashJson` from [`@warrant/warrant`](../warrant/README.md)) into the `listing_hash` carried by each cart line. The hash proves what was shown, not that the listing was accurate.

The merchant's reprice (rule V08) reads the merchant's own catalog through the `CatalogLookup` shape: unit price in integer cents, currency, availability, category and, optionally, the current listing hash. If the catalog is unreachable during a reprice, checkout fails closed.

`pnpm --filter @warrant/catalog test` runs the tests with coverage.
