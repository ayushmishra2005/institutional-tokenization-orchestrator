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
  exact unsigned transaction and receives `PENDING`, `SIGNED` or `REJECTED`. The signer
  applies its own policy (chain, signer address, no value transfers, allowlisted function
  selectors) and may refuse a request the workflow already approved.
- **Asynchronous signing**: a signer may answer later. One signer request is recorded per
  transaction attempt and keyed by the attempt, so a worker that restarts while a
  signature is outstanding resumes the request the provider already holds instead of
  creating a second signing intent for the same money.
- **Verify-then-persist-then-broadcast**: the returned signed transaction is decoded,
  its signer recovered, and every field compared against the committed request before
  the exact bytes and hash are persisted. Only then is anything broadcast.
- **`BROADCAST_UNKNOWN` is never `FAILED`.** A lost RPC acknowledgement is resolved by
  hash lookup or by rebroadcasting byte-for-byte identical bytes — never by creating a
  new mint.
- **Single-use operation references** on chain, so a duplicated delivery or a
  rebroadcast cannot mint twice.
- **Fresh compliance re-check** immediately before execution *and* again immediately
  before broadcast; the approval snapshot is not accepted as evidence at execution time.
  A signature that arrives after compliance was revoked is kept as evidence and never
  sent.
- **Compliance decisions expire.** An approval carries a validity window, a worker sweep
  retires lapsed approvals using database time, and revocation queues the on-chain
  eligibility withdrawal asynchronously. A settled mint is never rewritten: the chain
  cannot take it back, so only future eligibility changes.
- **Inclusion is not finality.** A receipt moves an operation to `INCLUDED`; only the
  chain profile's finality rule moves it to `SUCCEEDED`. An included block that leaves the
  canonical chain before then returns the operation to observation instead of failing it.
- **Fee replacement preserves intent.** A stuck attempt is replaced at the same nonce by
  the same signer with a higher fee and byte-identical calldata, proven by an intent
  fingerprint; the earlier attempt stays on record as `REPLACED`.
- **Reconciliation** of the receipt, the expected event, reference consumption,
  recipient balance and total supply before an operation is called `SUCCEEDED`.
- **Append-only audit events**, written in the same transaction as the state change
  they describe and protected by a database trigger.

## Chain profiles, finality and replacement

A chain profile (`src/platform/config/chain-profile.ts`) holds the per-chain behaviour the
rest of the code asks about rather than assumes: chain ID, RPC URL, EIP-1559 support, the
finality tag the chain exposes, the confirmation depth to fall back on, and the
replacement policy (how long an attempt may sit without inclusion, the fee bump, the
maximum number of replacements). Profiles are looked up by chain ID; the active profile
drives the runtime. Anvil exposes no `finalized` tag, so depth is the only evidence there
and the profile says so instead of treating a local receipt as mainnet finality.

Confirmation resolves to one of `PENDING`, `INCLUDED`, `FINALIZED`, `REVERTED` or
`ORPHANED`. Every observation persists the transaction hash, block number, block hash, a
canonical flag and the attempt it belongs to. When a block that carried an included
transaction is no longer canonical and the operation has not reached finality, the prior
observation is marked non-canonical (never deleted), the inclusion evidence on the attempt
is cleared, and the operation returns to `SUBMITTED` and keeps observing — no new nonce, no
second mint. Once an operation is finalized, normal reconciliation does not rewind it.

Replacement is worker-driven. An attempt that has been submitted without inclusion for
longer than the profile's threshold (measured with database time, not worker wall clock)
becomes eligible: a new attempt is signed with the same nonce, the same destination and the
same calldata, a bumped fee, and a link back to the attempt it replaces. The intent
fingerprint is compared before signing, so a replacement that would change the recipient,
amount, contract, function, operation reference, chain or signer is refused rather than
silently authorised by the original approval. A superseded attempt is never broadcast
again.

The same machinery clears a nonce lane blocked by a signed-but-withheld transaction — the
Phase 4 case where compliance is revoked after signing. Recovery signs a zero-value
self-transfer at exactly the blocked nonce, marked `NONCE_RECOVERY` and linked to the
abandoned attempt, so the nonce is consumed on chain with no asset effect and the lane
becomes usable again. The withheld financial transaction stays as evidence and can no
longer be broadcast.

`chain_id` is part of transaction identity, nonce lanes are per signer and chain, and
finality and replacement policy come from the profile, so a second EVM chain is a
configuration change rather than a redesign. Setting `TESTNET_RPC_URL` and
`TESTNET_CHAIN_ID` registers a second profile; nothing in the test suite or CI reads them.
`pnpm deploy:token [chainId]` deploys `InstitutionalToken` against a profile, verifying the
RPC's chain ID against it first and reading the deploying key from
`DEPLOY_SIGNER_PRIVATE_KEY` in the environment. No testnet deployment has been performed
from this repository.

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

`pnpm demo:clean` does the same from scratch: it tears the stack down **including its
volumes**, brings it back up, migrates and runs the demo.

`pnpm demo:revocation` runs the compliance side: it mints to an eligible wallet, revokes
the approval, waits for the on-chain eligibility withdrawal, and shows the settled mint
standing while a further mint is refused.

`pnpm demo:replacement` runs the fee replacement side: a mint whose broadcast response is
lost sits in `BROADCAST_UNKNOWN`, becomes replacement-eligible, and is replaced at the same
nonce with a higher fee. It prints both attempts — the original as `REPLACED`, the
replacement as `CONFIRMED` — and the recipient balance showing a single mint.

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
delivery semantics (duplicate delivery, lost queue message), crash recovery
(undispatched outbox, abandoned nonce reservation, receipt lookup lost mid-confirmation,
full Redis flush), asynchronous signing (pending signature resumed after a worker
restart, provider request reuse, rejection, malformed signed bytes, a late signature
withheld after revocation), fee replacement (same-nonce replacement of a stuck attempt,
refusal to broadcast a superseded attempt, the replacement ceiling, clearing a nonce lane
blocked by a withheld transaction), reorg handling (an included block that leaves the
canonical chain, finalisation once the chain settles, no rewind after finality) and the
compliance lifecycle (expiry sweep, re-screening,
revocation, duplicate revocation, revocation racing an in-flight mint).

CI runs the same commands: a quality job (typecheck, lint, unit tests, Foundry tests) and
an integration job that brings up PostgreSQL and Redis as service containers, starts the
same deterministic Anvil configuration, migrates, runs the integration suites and finishes
with the demo. CodeQL (JavaScript/TypeScript) and dependency review run on pull requests.

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
| `POST` | `/v1/wallets/{walletId}/compliance-decisions` | COMPLIANCE_OFFICER, ADMIN | Records (or re-screens) the decision and queues the on-chain eligibility sync; `202` |
| `POST` | `/v1/wallets/{walletId}/compliance-revocations` | COMPLIANCE_OFFICER, ADMIN | Withdraws a live approval and queues the on-chain withdrawal; `202` |
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

- One EVM chain, one local signer lane. No HSM, KMS, MPC or external custody. The
  asynchronous signer adapter reproduces the timing and refusal semantics of an external
  custody provider against the same local key; it is not an integration with one.
- Compliance decisions carry a validity window and can be revoked, but the screening
  itself is a mock adapter with no KYC, AML or sanctions data.
- Replacement and nonce recovery are worker policy with no operator override endpoint:
  the sweep decides, bounded by the profile's replacement ceiling. An attempt that has
  exhausted its replacements stays stuck and is left for an operator.
- Reconciliation findings are persisted and exposed through the operations API; there is
  no resolution workflow or UI.
- Finality on Anvil is confirmation depth, which is all that node can offer. Reorg
  handling is covered by a fault-injecting gateway in tests, not by Anvil.
- A contradiction discovered after finality is not detected: reconciliation does not
  re-examine finalized operations.
- Single-process deployment model. A second chain profile and a token deployment script
  exist, but no cloud or orchestration tooling, and no testnet run has been performed.
