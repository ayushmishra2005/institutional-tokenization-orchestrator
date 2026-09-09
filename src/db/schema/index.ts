/**
 * Drizzle mirror of src/db/migrations/*.sql, kept in step by hand. The migrations are
 * authoritative: constraints, partial indexes and triggers live there, not here.
 */
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  externalSubject: text('external_subject').notNull().unique(),
  organizationId: text('organization_id').notNull(),
  displayName: text('display_name').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    decimals: smallint('decimals').notNull(),
    supplyCap: numeric('supply_cap').notNull(),
    chainId: integer('chain_id').notNull(),
    contractAddress: text('contract_address'),
    deploymentTxHash: text('deployment_tx_hash'),
    status: text('status').notNull(),
    policyVersion: integer('policy_version').notNull().default(1),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('assets_org_symbol_key').on(table.organizationId, table.symbol)],
);

export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    chainId: integer('chain_id').notNull(),
    address: text('address').notNull(),
    label: text('label'),
    investorReference: text('investor_reference').notNull(),
    status: text('status').notNull().default('REGISTERED'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('wallets_chain_address_key').on(table.chainId, table.address)],
);

export const complianceDecisions = pgTable(
  'compliance_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => wallets.id),
    assetId: uuid('asset_id').references(() => assets.id),
    status: text('status').notNull(),
    subjectReference: text('subject_reference').notNull(),
    provider: text('provider').notNull(),
    providerReference: text('provider_reference').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by')
      .notNull()
      .references(() => users.id),
    chainSyncStatus: text('chain_sync_status').notNull().default('PENDING'),
    chainSyncTxHash: text('chain_sync_tx_hash'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('compliance_decisions_wallet_idx').on(table.walletId, table.decidedAt)],
);

export const operations = pgTable(
  'operations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    type: text('type').notNull(),
    state: text('state').notNull(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => assets.id),
    walletId: uuid('wallet_id').references(() => wallets.id),
    amount: numeric('amount'),
    operationReference: text('operation_reference').unique(),
    complianceDecisionId: uuid('compliance_decision_id').references(() => complianceDecisions.id),
    proposalHash: text('proposal_hash').notNull(),
    requiredApprovals: smallint('required_approvals').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    correlationId: text('correlation_id').notNull(),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    stateUpdatedAt: timestamp('state_updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('operations_state_idx').on(table.state, table.stateUpdatedAt)],
);

export const operationTransitions = pgTable(
  'operation_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    operationId: uuid('operation_id')
      .notNull()
      .references(() => operations.id),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('operation_transitions_operation_idx').on(table.operationId, table.id)],
);

export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  operationId: uuid('operation_id')
    .notNull()
    .references(() => operations.id),
  state: text('state').notNull(),
  requiredApprovals: smallint('required_approvals').notNull(),
  proposalSnapshot: jsonb('proposal_snapshot').notNull(),
  proposalHash: text('proposal_hash').notNull(),
  requestedBy: uuid('requested_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const approvalDecisions = pgTable(
  'approval_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalRequestId: uuid('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id),
    approverId: uuid('approver_id')
      .notNull()
      .references(() => users.id),
    operationRequestedBy: uuid('operation_requested_by').notNull(),
    decision: text('decision').notNull(),
    proposalHash: text('proposal_hash').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('approval_decisions_one_per_approver').on(
      table.approvalRequestId,
      table.approverId,
    ),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(),
    organizationId: text('organization_id').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_key').on(
      table.scope,
      table.organizationId,
      table.actorId,
      table.idempotencyKey,
    ),
  ],
);

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  topic: text('topic').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  lastError: text('last_error'),
  correlationId: text('correlation_id').notNull(),
  claimToken: uuid('claim_token'),
  claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    operationId: uuid('operation_id').references(() => operations.id),
    correlationId: text('correlation_id').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (table) => [index('audit_events_occurred_idx').on(table.occurredAt, table.id)],
);

export const signerNonces = pgTable(
  'signer_nonces',
  {
    chainId: integer('chain_id').notNull(),
    signerAddress: text('signer_address').notNull(),
    nextNonce: bigint('next_nonce', { mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.signerAddress] })],
);

export const transactionAttempts = pgTable(
  'transaction_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    operationId: uuid('operation_id').references(() => operations.id),
    assetId: uuid('asset_id').references(() => assets.id),
    walletId: uuid('wallet_id').references(() => wallets.id),
    purpose: text('purpose').notNull(),
    chainId: integer('chain_id').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address'),
    nonce: bigint('nonce', { mode: 'number' }).notNull(),
    value: numeric('value').notNull().default('0'),
    data: text('data').notNull(),
    gasLimit: bigint('gas_limit', { mode: 'number' }).notNull(),
    maxFeePerGas: numeric('max_fee_per_gas').notNull(),
    maxPriorityFeePerGas: numeric('max_priority_fee_per_gas').notNull(),
    requestHash: text('request_hash').notNull(),
    signedRawTransaction: text('signed_raw_transaction'),
    transactionHash: text('transaction_hash'),
    status: text('status').notNull(),
    broadcastAttempts: integer('broadcast_attempts').notNull().default(0),
    blockNumber: bigint('block_number', { mode: 'number' }),
    blockHash: text('block_hash'),
    gasUsed: bigint('gas_used', { mode: 'number' }),
    receiptStatus: smallint('receipt_status'),
    contractAddress: text('contract_address'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('transaction_attempts_nonce_lane_key').on(
      table.chainId,
      table.fromAddress,
      table.nonce,
    ),
  ],
);

export const chainObservations = pgTable('chain_observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  operationId: uuid('operation_id').references(() => operations.id),
  transactionAttemptId: uuid('transaction_attempt_id').references(() => transactionAttempts.id),
  kind: text('kind').notNull(),
  chainId: integer('chain_id').notNull(),
  blockNumber: bigint('block_number', { mode: 'number' }),
  transactionHash: text('transaction_hash'),
  matched: boolean('matched').notNull(),
  severity: text('severity').notNull().default('INFO'),
  status: text('status').notNull().default('OPEN'),
  expected: jsonb('expected'),
  actual: jsonb('actual'),
  detail: text('detail'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
