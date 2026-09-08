import type { Database } from '../../db/pool.js';
import {
  findWalletByAddress,
  findWalletById,
  insertWallet,
  type WalletRecord,
} from '../../db/repositories/wallet-repository.js';
import { recordAuditEvent } from '../../db/repositories/audit-repository.js';
import { AppError, ErrorCode, NotFoundError } from '../../domain/errors.js';
import { AppRole } from '../../domain/roles.js';
import { requireRole } from '../../platform/auth/authorize.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { RequestContext } from '../context.js';

export interface RegisterWalletInput {
  readonly address: string;
  readonly investorReference: string;
  readonly label?: string | undefined;
}

export class WalletService {
  constructor(
    private readonly db: Database,
    private readonly chainId: number,
  ) {}

  async registerWallet(ctx: RequestContext, input: RegisterWalletInput): Promise<WalletRecord> {
    requireRole(
      ctx.actor,
      [AppRole.ISSUER, AppRole.ADMIN, AppRole.COMPLIANCE_OFFICER],
      'register a wallet',
    );

    try {
      return await this.db.transaction(async (tx) => {
        const wallet = await insertWallet(tx, {
          organizationId: ctx.actor.organizationId,
          chainId: this.chainId,
          address: input.address,
          label: input.label ?? null,
          investorReference: input.investorReference,
          createdBy: ctx.actor.id,
        });
        await recordAuditEvent(tx, {
          actor: ctx.actor,
          action: 'wallet.registered',
          resourceType: 'wallet',
          resourceId: wallet.id,
          correlationId: ctx.correlationId,
          // The investor reference is an opaque operator handle, not identity data.
          metadata: {
            address: wallet.address,
            chainId: wallet.chainId,
            investorReference: wallet.investorReference,
          },
        });
        return wallet;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          ErrorCode.OPERATION_CONFLICT,
          'wallet address is already registered on this chain',
          { details: { address: input.address.toLowerCase() } },
        );
      }
      throw error;
    }
  }

  async getWallet(ctx: RequestContext, walletId: string): Promise<WalletRecord> {
    const wallet = await findWalletById(this.db, walletId);
    if (wallet === null || wallet.organizationId !== ctx.actor.organizationId) {
      throw new NotFoundError('wallet', walletId);
    }
    return wallet;
  }

  async findByAddress(address: string): Promise<WalletRecord | null> {
    return findWalletByAddress(this.db, this.chainId, address);
  }
}
