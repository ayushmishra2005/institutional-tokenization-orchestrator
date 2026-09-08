# institutional-tokenization-orchestrator

Node.js/TypeScript backend for institutional digital-asset issuance: tokenized asset
creation, investor wallet registration, compliance decisions, two-person approval,
EVM transaction orchestration with a signer boundary, and asynchronous reconciliation
with a full audit trail.

The scope is one complete vertical slice — an approved mint executed against a local EVM
chain and reconciled back into PostgreSQL — rather than a broad API surface.

> **This is an open-source reference implementation / engineering project. It is NOT
> production-ready financial infrastructure.** The local signer and the mock compliance
> provider are development adapters: the signer holds a well-known Anvil test key in
> process memory, and the compliance provider performs no KYC, AML or sanctions
> screening whatsoever. It is not affiliated with, derived from, or endorsed by any
> commercial token issuer.

## Architecture

A modular monolith with two runtime entry points sharing one codebase and one
PostgreSQL schema:

- **`src/api`** — Fastify HTTP API. Owns request validation, authorization, and the
  transactional workflow that records financial intent.
- **`src/worker`** — outbox dispatcher, BullMQ consumer, and recovery sweep. Owns
  execution against the chain.

Responsibility is split by authority:

| Authority | Owns |
| --- | --- |
| PostgreSQL | Application workflow: users and roles, assets, wallets, compliance decisions, operations, approvals, idempotency records, outbox, audit events, nonce reservations, transaction attempts, reconciliation observations |
| EVM contract | Canonical asset state: roles, pause state, on-chain eligibility, balances, total supply, consumed mint references, emitted events |
| Redis / BullMQ | Delivery only. Deleting Redis loses no financial or business intent — jobs are rebuilt from the PostgreSQL outbox by the recovery sweep |

The properties the design exists to guarantee:

- **Two-person approval**, enforced by database constraints rather than application
  code alone. The same actor cannot satisfy both approvals even via direct SQL.
- **Approval binds to an immutable proposal snapshot.** Changing the financial intent
  invalidates prior approvals instead of silently reusing them.
- **Idempotent financial mutations** keyed in PostgreSQL, not Redis.
- **Transactional outbox**: business state and the asynchronous work item commit
  atomically. Queue payloads carry identifiers only; the worker reloads authoritative
  state from PostgreSQL.
- **Signer boundary**: application code never touches a private key. It submits an
  exact unsigned transaction and receives `SIGNED` or `REJECTED`.
- **Verify-then-persist-then-broadcast**: the returned signed transaction is decoded,
  its signer recovered, and every field compared against the committed request before
  the exact bytes and hash are persisted. Only then is anything broadcast.
- **`BROADCAST_UNKNOWN` is never `FAILED`.** A lost RPC acknowledgement is resolved by
  hash lookup or by rebroadcasting byte-for-byte identical bytes — never by creating a
  new mint.
- **Single-use operation references** on chain, so a duplicated delivery or a
  rebroadcast cannot mint twice.
- **Fresh compliance re-check** immediately before execution; the approval snapshot is
  not accepted as evidence at execution time.
- **Reconciliation** of the receipt, the expected event, reference consumption,
  recipient balance and total supply before an operation is called `SUCCEEDED`.
- **Append-only audit events**, written in the same transaction as the state change
  they describe and protected by a database trigger.

## Technology

Node.js 20+, TypeScript (strict), Fastify, Zod, PostgreSQL, Drizzle ORM, node-postgres,
Redis, BullMQ, viem, Solidity 0.8.28, Foundry/Anvil, OpenZeppelin Contracts, Vitest,
Pino, prom-client, Docker Compose.

## Prerequisites

- Node.js 20 or newer and [pnpm](https://pnpm.io)
- Docker (for PostgreSQL, Redis and Anvil)
- [Foundry](https://book.getfoundry.sh) (`forge`) for the contract build and tests

Contract dependencies are pinned git submodules:

```sh
git submodule update --init --recursive
```

## Local startup

```sh
pnpm install
cp .env.example .env          # local development values only
pnpm infra:up                 # PostgreSQL, Redis, Anvil
pnpm contracts:build          # compile the token contract
pnpm contracts:sync           # copy ABI + bytecode into src/adapters/evm
pnpm db:migrate
```

Then run the two processes in separate terminals:

```sh
pnpm api
pnpm worker
```

`pnpm infra:down` tears the stack down and removes its volumes.

## Demo

With the infrastructure up and migrations applied:

```sh
pnpm demo
```

`scripts/demo-mint.ts` drives the whole slice in-process — asset creation, wallet
registration, compliance approval, mint request, both approvals, worker execution,
confirmation and reconciliation — then prints the operation ID, transaction hash,
contract address, recipient, minted amount and final state. It starts its own worker
runtime, so `pnpm worker` need not be running.

## Tests

```sh
pnpm typecheck
pnpm lint
pnpm test:unit          # domain, state machines, signing, verification
pnpm contracts:test     # Foundry: happy path and adversarial cases
pnpm test:integration   # requires pnpm infra:up
```

Integration suites share one PostgreSQL/Redis/Anvil stack and therefore run serially.
They cover the end-to-end mint, idempotency under 100 concurrent duplicate requests,
approval concurrency, database-level concurrency (outbox claiming against the database
clock, nonce reservation, audit immutability), transport faults (ambiguous broadcast,
exact-byte rebroadcast, on-chain revert, signer and compliance rejection), worker
delivery semantics (duplicate delivery, lost queue message), and crash recovery
(undispatched outbox, abandoned nonce reservation, receipt lookup lost mid-confirmation,
full Redis flush).

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests and Foundry tests. The
integration suites need the full local stack and are run locally, not in CI.

## API

All `/v1` routes require `Authorization: Bearer <token>`. Local development tokens are
minted for fixed personas (`dev-admin`, `dev-issuer`, `dev-compliance`,
`dev-approver-1`, `dev-approver-2`, `dev-auditor`); the demo script prints them.
Authorization is enforced in the application services, not only in route handlers.

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/assets` | ISSUER, ADMIN | Queues the token deployment; `202` with a provisioning operation ID |
| `GET` | `/v1/assets/{assetId}` | any | Asset and contract address |
| `POST` | `/v1/wallets` | ISSUER, ADMIN | Registers an investor wallet; `201` |
| `POST` | `/v1/wallets/{walletId}/compliance-decisions` | COMPLIANCE_OFFICER, ADMIN | Records the decision and queues the on-chain eligibility sync; `202` |
| `POST` | `/v1/assets/{assetId}/mints` | ISSUER, ADMIN | Requires `Idempotency-Key`; returns `202` with an operation ID |
| `POST` | `/v1/approval-requests/{requestId}/decisions` | APPROVER | `APPROVE` or `REJECT` |
| `GET` | `/v1/operations/{operationId}` | any | State, transition history, transaction attempts, reconciliation findings |
| `GET` | `/v1/audit-events` | AUDITOR, ADMIN | Append-only audit trail |
| `GET` | `/health/live`, `/health/ready` | none | API readiness checks PostgreSQL, its only synchronous dependency |
| `GET` | `/metrics` | none | Prometheus exposition |

Errors use a stable envelope with a machine-readable code and never include stack
traces:

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "idempotency key was already used with a different request",
    "requestId": "...",
    "correlationId": "..."
  }
}
```

## Security notes

- `LOCAL_SIGNER_PRIVATE_KEY` in `.env.example` is Anvil's first well-known test account
  from the public `test test test ... junk` mnemonic. It controls nothing. Never reuse
  it, and never point this signer at a real network.
- There is no generic `sign(bytes)` entry point and no arbitrary-calldata path. Chain
  writes are built only from allowlisted encoders (`deploy`, `mintWithReference`,
  `setEligibility`) against a verified contract address and chain ID.
- Private keys, JWTs, signed raw transactions and authorization secrets are redacted
  from logs and never returned by the API.
- `.env` is git-ignored. No secrets belong in this repository.
- The token contract implements ERC-20 only. It does **not** implement ERC-1400,
  ERC-1404 or any other security-token standard, and claims no such support.

## Limitations

- One EVM chain, one local signer lane. No HSM, KMS, MPC or external custody.
- No fee replacement (RBF) or gas escalation: a stuck transaction stays stuck until an
  operator intervenes.
- Reconciliation findings are persisted and exposed through the operations API; there is
  no resolution workflow or UI.
- Compliance is a mock adapter with no KYC, AML or sanctions screening.
- Finality on Anvil is approximated by a small confirmation depth; reorgs are not
  modelled.
- Single-process deployment model. No deployment tooling, no cloud, no testnet or
  mainnet configuration.
