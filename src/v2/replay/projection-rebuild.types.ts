/** PREWAVE-BE-002 — deterministic full replay / projection rebuild. */

export type RebuildMode =
  | 'dry-run'
  | 'rebuild'
  | 'resume'
  | 'verify'
  | 'cutover';

export interface ReplayBinding {
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
}

export interface ReplayCheckpoint {
  chainId: number;
  /** Last successfully applied canonical event order key. */
  lastBlockNumber: string;
  lastLogIndex: number;
  lastEventId: string | null;
  updatedAt: string;
}

export interface ProjectionDigest {
  projector: string;
  rowCount: number;
  /** sha256 hex of canonical sorted projection payload. */
  digest: string;
}

export interface ReplayReport {
  schemaVersion: 1;
  mode: RebuildMode;
  binding: ReplayBinding;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  resumable: boolean;
  eventsRead: number;
  eventsApplied: number;
  eventsSkipped: number;
  checkpoint: ReplayCheckpoint | null;
  digests: ProjectionDigest[];
  /** true only when verify/cutover compared equal digests */
  digestsMatch: boolean | null;
  cutoverApplied: boolean;
  errors: string[];
  /** Never includes secrets, signatures, evidence, or auth material. */
  notes: string[];
}

export interface CanonicalEventLike {
  id: string;
  chainId: number;
  contractAddress: string;
  artifactVersion: string;
  eventName: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  payload: Record<string, unknown>;
}

export interface ProjectorAdapter {
  name: string;
  /** Apply one event; must be idempotent for the same (txHash, logIndex). */
  apply(event: CanonicalEventLike): Promise<'applied' | 'skipped' | 'anomaly'>;
  /** Deterministic snapshot of projected rows for digesting. */
  snapshot(): Promise<unknown[]>;
  /** Clear projection rows for isolated rebuild target (non-production only). */
  reset?(): Promise<void>;
  }
