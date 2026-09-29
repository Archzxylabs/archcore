export type SettlementJobStage =
  | 'PREPARING'
  | 'SUBMITTED'
  | 'MINED'
  | 'RECONCILING'
  | 'CONFIRMED'
  | 'FAILED';

export const ALLOWED_STAGES = new Set<SettlementJobStage>([
  'PREPARING',
  'SUBMITTED',
  'MINED',
  'RECONCILING',
  'CONFIRMED',
  'FAILED',
]);

export const JOURNAL_TRANSITION_CONFLICT = 'JOURNAL_TRANSITION_CONFLICT';
export const JOURNAL_PERSISTENCE_FAILED = 'JOURNAL_PERSISTENCE_FAILED';
export const AUTO_SETTLEMENT_DISABLED = 'AUTO_SETTLEMENT_DISABLED';
export const CAPABILITY_MISSING = 'CAPABILITY_MISSING';


export interface SettlementJobIdentity {
  chainId: number;
  rentalManagerAddress: string;
  rentalId: string;
}

export interface SettlementJobScope {
  chainId: number;
  rentalManagerAddress: string;
  nodeId?: string;
}

export interface SettlementJob {
  schemaVersion: number;
  chainId: number;
  rentalManagerAddress: string;
  rentalId: string;
  nodeId: string;
  stage: SettlementJobStage;
  txHash: string | null;
  senderAddress: string | null;
  transactionNonce: string | null;
  attempts: number;
  nextRetryAtMs: number | null;
  failureCode: string | null;
  claimOwner: string | null;
  claimExpiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SettlementJournal {
  initialize(): Promise<void> | void;
  close(): Promise<void> | void;
  createOrLoadJob(
    identity: SettlementJobIdentity,
    initial: { nodeId: string; ownerId?: string; claimExpiresAtMs?: number },
  ): Promise<SettlementJob> | SettlementJob;
  getJob(identity: SettlementJobIdentity): Promise<SettlementJob | null> | SettlementJob | null;
  listRecoverableJobs(scope: SettlementJobScope): Promise<SettlementJob[]> | SettlementJob[];
  claimJob(
    identity: SettlementJobIdentity,
    ownerId: string,
    leaseExpiresAtMs: number,
  ): Promise<boolean> | boolean;
  renewClaim(
    identity: SettlementJobIdentity,
    ownerId: string,
    leaseExpiresAtMs: number,
  ): Promise<boolean> | boolean;
  releaseClaim(
    identity: SettlementJobIdentity,
    ownerId: string,
  ): Promise<boolean> | boolean;
  recordPreparing(
    identity: SettlementJobIdentity,
    params: { senderAddress: string; transactionNonce: string; ownerId: string },
  ): Promise<boolean> | boolean;
  recordSubmitted(
    identity: SettlementJobIdentity,
    params: { txHash: string; ownerId: string },
  ): Promise<boolean> | boolean;
  recordMined(
    identity: SettlementJobIdentity,
    params: { ownerId: string },
  ): Promise<boolean> | boolean;
  recordReconciling(
    identity: SettlementJobIdentity,
    params: { ownerId: string },
  ): Promise<boolean> | boolean;
  recordConfirmed(
    identity: SettlementJobIdentity,
    params: { ownerId: string },
  ): Promise<boolean> | boolean;
  recordFailed(
    identity: SettlementJobIdentity,
    params: { failureCode: string; ownerId: string },
  ): Promise<boolean> | boolean;
  recordRetryableFailure(
    identity: SettlementJobIdentity,
    params: { failureCode: string; nextRetryAtMs: number; ownerId: string },
  ): Promise<boolean> | boolean;
  pruneConfirmed?(beforeTimestampMs: number): Promise<number> | number;
}
