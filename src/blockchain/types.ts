/*
 * Core types for blockchain event tracking and reorg handling
 */

export interface BlockInfo {
  number: number;
  hash: string;
  timestamp: number;
  parentHash: string;
}

export interface BlockRecord {
  id: string; // blockNumber:blockHash
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  timestamp: number;
  isCanonical: boolean;
  createdAt: Date;
}

export interface PendingEvent {
  id: string;
  blockNumber: number;
  blockHash: string;
  eventType: string;
  data: Record<string, any>;
  transactionHash: string;
  logIndex: number;
  status: 'Pending' | 'confirmed' | 'orphaned';
  confirmations: number;
  createdAt: Date;
  confirmedAt?: Date;
}

export interface ReorgEvent {
  detectedAt: Date;
  reorgDepth: number;
  affectedBlockStart: number;
  affectedBlockEnd: number;
  orphanedEvents: string[]; // event IDs
  reprocessedEvents: string[];
}

export interface ChainState {
  lastProcessedBlock: number;
  lastCanonicalHash: string;
  confirmedDepth: number;
  pendingEventCount: number;
  orphanedEventCount: number;
  lastReorgTime?: Date;
  /**
   * Highest block number observed from the RPC provider (observed head).
   */
  observedHeadBlock?: number;
  /**
   * Block number considered safe (reorg-unlikely) by the provider's finality tags.
   */
  safeBlock?: number;
  /**
   * Block number considered finalized by the provider's finality tags.
   */
  finalizedBlock?: number;
  /**
   * Highest block number to which projections (derived state) have advanced.
   */
  projectionHeadBlock?: number;
  /**
   * Cumulative number of RPC failures observed.
   */
  rpcFailureCount?: number;
  /**
   * Cumulative number of event replays processed (reprocessed after reorg/retry).
   */
  replayCount?: number;
  /**
   * Cumulative number of dead-lettered events (failed past max retries).
   */
  deadLetterCount?: number;
  /**
   * ISO timestamp of the last RPC failure (if any).
   */
  lastRpcErrorAt?: string | null;
  /**
   * Last recorded projection lag (observedHeadBlock - finalizedBlock), >= 0.
   */
  projectionLag?: number;
}

export type IndexerHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Sanitized snapshot of indexer health.
 * Exposes only operational numeric values and a generic runbook link —
 * never credentials, user data, or live RPC URLs.
 */
export interface IndexerHealthSnapshot {
  status: IndexerHealthStatus;
  timestamp: string;
  observedHeadBlock: number;
  safeBlock: number;
  finalizedBlock: number;
  projectionHeadBlock: number;
  /** Finalized canonical blocks not yet applied to projections (>= 0). */
  indexerLagBlocks: number;
  /** Observed head distance from the finalized cursor (>= 0). */
  finalityLagBlocks: number;
  projectionLag: number;
  rpcFailureCount: number;
  replayCount: number;
  deadLetterCount: number;
  alertThresholds: {
    indexerLagBlocks: number;
    finalityLagBlocks: number;
    /** @deprecated Retained as an alias for finalityLagBlocks. */
    projectionLagBlocks: number;
    rpcFailureRateWindow: number;
    maxDeadLetters: number;
  };
  runbookUrl: string;
}


export interface StateMemoryStats {
  currentBlockCount: number;
  currentEventCount: number;
  currentReorgHistoryCount: number;
  maxBlocksInMemory: number;
  maxEventsInMemory: number;
  maxReorgHistoryEntries: number;
  confirmedEventCount: number;
  pendingEventCount: number;
  orphanedEventCount: number;
}


/**
 * Verification and Voting Types
 */

export type Verdict = 'TRUE' | 'FALSE' | 'UNSURE';


export interface VerificationVote {
  claimId: string;
  userId: string;
  verdict: Verdict;
  stakeAmount: string; // BigInt as string
  userReputation: number;
  timestamp: Date;
  eventId: string; // Reference to blockchain event
}

export interface WeightedVote {
  claimId: string;
  userId: string;
  verdict: Verdict;
  stakeAmount: string;
  userReputation: number;
  weight: number; // Calculated weight
  timestamp: Date;
}

export interface VoteAggregation {
  claimId: string;
  totalWeight: number;
  verdictWeights: Record<Verdict, number>;
  voterCount: number;
  votes: WeightedVote[];
}

export interface ClaimResolution {
  claimId: string;
  resolvedVerdict: Verdict | 'UNRESOLVED';
  confidenceScore: number; // 0.0 to 1.0
  resolutionMargin: number; // Difference between top two verdicts
  totalWeight: number;
  voterCount: number;
  verdictDistribution: Record<Verdict, number>;
  metadata: {
    timestamp: Date;
    dominantVerdictWeight: number;
    secondVerdictWeight: number;
    isTie: boolean;
    isLowConfidence: boolean;
  };
}

export interface ResolutionConfig {
  minTotalWeight: number; // Minimum weight to resolve
  confidenceThreshold: number; // Minimum confidence (0.0-1.0)
  maxReputationShare: number; // Max % one user can contribute (0.0-1.0)
  tieThreshold: number; // Margin threshold for ties
}


/**
 * Realtime Backpressure and SlowConsumer Isolation Types
 *
 * These types define the bounded per-connection queue, drop/disconnect policy,
 * heartbeat, and catch-up handoff contracts used to prevent a single slow
 * client from exhausting shared worker memory.
 */

/**
 * Policy applied when a per-connection queue exceeds its bound.
 * - `drop-oldest`: evict the oldest queued message to make room (resumable).
 * - `drop-newest`: reject the incoming message (resumable).
 * - `disconnect`: close the connection and require reconnect + catch-up.
 */
export type BackpressurePolicy = 'drop-oldest' | 'drop-newest' | 'disconnect';

/**
 * Reason a connection was dropped or a message was discarded.
 * Used for auditability and to drive the client's recovery path.
 */
export type BackpressureDropReason =
  | 'queue_overflow'
  | 'slow_consumer'
  | 'heartbeat_timeout'
  | 'shutdown'
  | 'unauthorized'
  | 'stale_cursor';

/**
 * Bounded per-connection queue configuration.
 * All limits are enforced per connection; no shared unbounded buffer exists.
 */
export interface ConnectionQueueConfig {
  /** Maximum number of messages buffered per connection. */
  maxQueueDepth: number;
  /** Maximum total buffered bytes per connection (approximate). */
  maxQueueBytes: number;
  /** Policy applied when either bound is exceeded. */
  overflowPolicy: BackpressurePolicy;
  /** Interval between heartbeat pings, in milliseconds. */
  heartbeatIntervalMs: number;
  /** Time without a heartbeat ack before the connection is considered lost. */
  heartbeatTimeoutMs: number;
  /** Maximum time a slow consumer may remain before forced disconnect. */
  slowConsumerGraceMs: number;
}

/**
 * A single queued realtime message with a monotonic sequence number so that
 * dropped clients can resume from a known cursor.
 */
export interface QueuedRealtimeMessage<T = unknown> {
  /** Monotonic per-connection sequence number. */
  sequence: number;
  /** Chain ID the message is bound to. */
  chainId: number;
  /** Release ID the message is bound to. */
  releaseId: string;
  /** Deployment block the message is bound to. */
  deploymentBlock: number;
  /** Artifact checksum the message is bound to. */
  artifactChecksum: string;
  /** Event type discriminator (never contains protected payload). */
  eventType: string;
  /** Canonical event ID, if applicable. */
  eventId?: string;
  /** Opaque payload; must not be logged on overflow. */
  payload: T;
  /** Approximate serialized size in bytes. */
  sizeBytes: number;
  /** Enqueue timestamp (ms since epoch). */
  enqueuedAt: number;
}

/**
 * Per-connection backpressure and heartbeat state.
 * Bounded by construction: `queue` length never exceeds `config.maxQueueDepth`.
 */
export interface ConnectionBackpressureState {
  connectionId: string;
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  config: ConnectionQueueConfig;
  /** Bounded FIFO queue. */
  queue: QueuedRealtimeMessage[];
  /** Total buffered bytes (approximate). */
  bufferedBytes: number;
  /** Last sequence number successfully delivered to the client. */
  lastDeliveredSequence: number;
  /** Last sequence number enqueued. */
  lastEnqueuedSequence: number;
  /** Last heartbeat ack timestamp (ms since epoch). */
  lastHeartbeatACkAt: number;
  /** Whether the connection is currently considered slow. */
  isSlowConsumer: boolean;
  /** Whether the connection has been dropped. */
  isDropped: boolean;
  /** Reason for the most recent drop, if any. */
  dropReason?: BackpressureDropReason;
}

/**
 * Catch-up handoff descriptor returned to a dropped client so it can resume
 * from a known cursor without replaying the entire stream.
 */
export interface CatchUpHandoff {
  connectionId: string;
  chainId: number;
  releaseId: string;
  deploymentBlock: number;
  artifactChecksum: string;
  /** Sequence number the client should resume from (exclusive). */
  resumeFromSequence: number;
  /** Reason the connection was dropped. */
  dropReason: BackpressureDropReason;
  /** ISO timestamp when the handoff was issued. */
  issuedAt: string;
  /** Whether the client must re-authenticate before resuming. */
  requiresReauth: boolean;
}

/**
 * Sanitized backpressure metrics for observability.
 * Never includes payloads, credentials, or live RPC URLs.
 */
export interface BackpressureMetricsSnapshot {
  timestamp: string;
  activeConnections: number;
  droppedConnections: number;
  slowConsumerCount: number;
  totalQueueDepth: number;
  maxQueueDepthObserved: number;
  totalBufferedBytes: number;
  maxBufferedBytesObserved: number;
  overflowDropCount: number;
  heartbeatTimeoutCount: number;
  catchUpHandoffCount: number;
}
