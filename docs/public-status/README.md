# Public Service-Status Projection (UX-BE-001)

`GET /status/public` returns a sanitized, versioned (`public-status.v1`) status
`projection for the public status page. It is unauthenticated, cached and rate
limited. The protected `/health/*` reports are unchanged and are **not** the
source of truth for the public page.

## Published artifacts

| File | Purpose |
| --- | --- |
| [`openapi.json`](./openapi.json) | OpenAPI 3 document for the endpoint and its DTOs |
| [`fixtures.json`](./fixtures.json) | Frontend fixtures, one per scenario (operational, unavailable, delayed, stale, wrong release, not configured) |

Both are verified against the code by
`src/health/public-status/public-status.artifacts.spec.ts`. Regenerate after a
schema change with:

```bash
UPDATE_PUBLIC_STATUS_ARTIFACTS=1 npx jest public-status.artifacts
```

## Schema

- `components[]`: `web`, `api`, `rpc`, `indexer`, `database`, `evidence_gateway`
- `release`: release ID, chain ID, deployment block, artifact checksum
- `chain`: finalized block, indexed block, lag in blocks
- `cache`: `maxAgeSeconds`, `staleAfterSeconds`, `expiresAt`

Every component, `release` and `chain` carries an `observation` with `source`,
`observedAt`, `ageSeconds` and `freshness` (`fresh` | `stale` | `unknown`).

States: `operational`, `degraded`, `delayed`, `stale`, `unavailable`, `unknown`.
`overall` is the worst state, in the order
operational < degraded < delayed < stale < unknown < unavailable.

## Liveness, startup, readiness and degraded

The public projection is built from four distinct signals that must not be
conflated:

| Signal | Meaning | Public status |
| --- | --- | --- |
| Liveness | Process is running and able to respond to a cheap probe. | Never sufficient for `operational`. |
| Startup | Initialization has completed and dependencies are bound. | If incomplete, components are `unknown` (not observed). |
| Readiness | All required dependencies have a fresh, successful observation. | Required for `operational`. |
| Degraded | Ready, but a non-critical signal is late or partial. | Reported as `degraded`, never `operational`. |

A stale last success is not readiness: a component whose most recent successful
observation is older than `staleAfterSeconds` is `stale` even if its last
recorded outcome was success. Recovery requires a fresh successful
observation; older successes do not clear `stale`, `unknown` or `unavailable`.

## Observation and dependency provenance

Each component and each chain-derived block publishes an `observation`:

- `observedAt`: time the underlying signal was observed (ISO 8601).
- `lastSuccessAt`: time of the most recent successful observation, or null if none.
- `source`: the probe or cursor that produced the observation.
- `ageSeconds`: age of `observedAt` at projection time.
- `freshness`: `fresh` | `stale` | `unknown`.

Chain-derived data (chain head, finalized block, indexed block, projection lag)
is bound to provenance before it is published:

- `chainId`: the chain the blocks belong to.
- `releaseId`: the release cursor binding.
- `deploymentBlock`: the block the release was deployed at.
- `artifactChecksum`: checksum of the release artifact the cursor was built from.

A chain-derived observation whose `chainId`, `releaseId`, `deploymentBlock` or
`artifactChecksum` is missing, ambiguous or does not match the configured
release is not published as block data; the component is `unavailable` and no
block numbers are reported.

## Fail-closed rules

- No observation → `unknown` (source `not_observed`). Never `operational`.
- Observation older than `staleAfterSeconds` → `stale`. A recorded success is not readiness.
- Any failed required dependency probe … `unavailable`, whatever its internal criticality.
- Required dependency failure removes readiness from the whole projection.
- Recovery requires a fresh successful observation; older successes do not clear a
  failed or stale state.
- Finalized lag beyond policy … `delayed`.
- Cursor bound to a different release → `unavailable`, and no block numbers are published.
- Stale, ambiguous, missing or unauthorized state fails closed.

## Redaction

The response is built field-by-field from allow-listed DTOs (`src/health/public-status/public-status.dto.ts`); nothing from internal
reports is spread or passed through. Hostnames, URLs, failure messages, stack
traces, response times, criticality, diagnostics and secrets never appear.

The public projection is sanitized: it exposes only the allow-listed state,
observation timestamps, freshness, block numbers and release provenance described
above.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_STATUS_CACHE_TTL_SECONDS` | `15` | Server cache and `Cache-Control: max-age` |
| `PUBLIC_STATUS_STALE_AFTER_SECONDS` | `120` | Age after which observations are `stale` |
| `PUBLIC_STATUS_WEB_HEALTH_URL` | unset | Web frontend URL to probe; `web` is `unknown` when unset |
| `PUBLIC_STATUS_WEB_PROBE_TIMEOUT_MS` | `2000` | Web probe timeout |
| `PUBLIC_STATUS_RATE_LIMIT` | `60` | Requests per client IP per window |
| `PUBLIC_STATUS_RATE_WINDOW_SECONDS` | `60` | Rate limit window |

Chain, indexer, RPC and release data come from the finalized-block cursor
(PREWAVE-BE-001, see [`../FINALIZED_CURSOR.md`](../FINALIZED_CURSOR.md)); they
are `unknown` until a release binding is configured.
