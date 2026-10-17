import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Cache Health Service
 *
 * Tracks cache health metrics and failure rates to ensure cache failures are
 * observable and actionable. Per V2-BE-116, cache failures must be isolated
 * from canonical state and never silently fallback to fabricated state.
 */
export type ReadinessState =
  | 'live'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'not_ready';

export type DependencyStatus = 'up' | 'down' | 'unknown';

export interface DependencyProvenance {
  name: string;
  status: DependencyStatus;
  required: boolean;
  observedAt: string | null;
  lastSuccessAt: string | null;
  detail?: string;
}

export interface ChainProvenance {
  chainId: number | null;
  releaseId: string | null;
  deploymentBlock: number | null;
  artifactChecksum: string | null;
  chainHead: number | null;
  finalizedBlock: number | null;
  projectionLag: number | null;
  observedAt: string | null;
}

export interface SanitizedReadinessStatus {
  state: ReadinessState;
  ready: boolean;
  live: boolean;
  starting: boolean;
  degraded: boolean;
  observedAt: string;
  lastSuccessAt: string | null;
  stale: boolean;
  dependencies: Array<{
    name: string;
    status: DependencyStatus;
    required: boolean;
  }>;
}

@Injectable()
export class CacheHealthService {
  private readonly logger = new Logger(CacheHealthService.name);
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: Date | null = null;
  private readonly FAILURE_THRESHOLD = 10; // Number of failures before marking as degraded
  private readonly RESET_INTERVAL_MS = 60000; // Reset counters every minute

  // Freshness / provenance tracking (PREWAVE-BE-044)
  private readonly STALE_SUCCESS_MS = 30000; // last-success older than this is stale
  private readonly MAX_PROJECTION_LAG = 50; // blocks
  private lastSuccessAt: Date | null = null;
  private lastObservedAt: Date | null = null;
  private startedAt: Date = new Date();
  private dependencies: Map<string, DependencyProvenance> = new Map();
  private chain: ChainProvenance = {
    chainId: null,
    releaseId: null,
    deploymentBlock: null,
    artifactChecksum: null,
    chainHead: null,
    finalizedBlock: null,
    projectionLag: null,
    observedAt: null,
  };

  constructor(
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService,
  ) {
    this.startMetricsReporting();
  }

  /**
   * Record a successful cache operation
   */
  recordSuccess(operation: string): void {
    this.successCount++;
    this.lastSuccessAt = new Date();
    this.metricsService.incrementCounter('cache_operations_total', {
      operation,
      status: 'success',
    });
  }

  /**
   * Record a failed cache operation
   */
  recordFailure(operation: string, key?: string, error?: Error): void {
    this.failureCount++;
    this.lastFailureTime = new Date();

    this.metricsService.incrementCounter('cache_operations_total', {
      operation,
      status: 'failure',
    });

    this.metricsService.incrementCounter('cache_failures_total', {
      operation,
    });

    // Log the failure for observability
    this.logger.error(
      `Cache operation failed: ${operation}${key ? ` (key: ${key})` : ''}`,
      error?.stack,
    );

    // Alert if failure threshold exceeded
    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      this.logger.error(
        `Cache failure threshold exceeded: ${this.failureCount} failures in current window`,
      );
      this.metricsService.incrementCounter('cache_degraded_total');
    }
  }

  /**
   * Get current cache health status
   */
  getHealthStatus(): {
    healthy: boolean;
    failureCount: number;
    successCount: number;
    failureRate: number;
    lastFailureTime: Date | null;
    redisConnected: boolean;
  } {
    const total = this.failureCount + this.successCount;
    const failureRate = total > 0 ? this.failureCount / total : 0;
    const redisConnected = this.redisService.getStatus().connected;

    return {
      healthy: this.failureCount < this.FAILURE_THRESHOLD && redisConnected,
      failureCount: this.failureCount,
      successCount: this.successCount,
      failureRate,
      lastFailureTime: this.lastFailureTime,
      redisConnected,
    };
  }

  /**
   * Register or update a dependency's provenance observation.
   * Required dependencies failing will remove readiness.
   */
  recordDependency(
    name: string,
    status: DependencyStatus,
    required: boolean,
    detail?: string,
  ): void {
    const now = new Date();
    const existing = this.dependencies.get(name);
    const lastSuccessAt: string | null =
      status === 'up'
        ? now.toISOString()
        : existing?.lastSuccessAt ?? null;

    this.dependencies.set(name, {
      name,
      status,
      required,
      observedAt: now.toISOString(),
      lastSuccessAt,
      detail,
    });

    this.metricsService.setGauge(
      'dependency_up',
      status === 'up' ? 1 : 0,
      { dependency: name, required: required ? 'true' : 'false' },
    );
  }

  /**
   * Bind chain-derived data to chain ID, release ID, deployment block,
   * and artifact checksum. Canonical contracts/finalized events remain
   * authoritative; this only records observed provenance.
   */
  recordChainProvenance(update: {
    chainId?: number;
    releaseId?: string;
    deploymentBlock?: number;
    artifactChecksum?: string;
    chainHead?: number;
    finalizedBlock?: number;
  }): void {
    const now = new Date();
    if (update.chainId !== undefined) this.chain.chainId = update.chainId;
    if (update.releaseId !== undefined) this.chain.releaseId = update.releaseId;
    if (update.deploymentBlock !== undefined)
      this.chain.deploymentBlock = update.deploymentBlock;
    if (update.artifactChecksum !== undefined)
      this.chain.artifactChecksum = update.artifactChecksum;
    if (update.chainHead !== undefined) this.chain.chainHead = update.chainHead;
    if (update.finalizedBlock !== undefined)
      this.chain.finalizedBlock = update.finalizedBlock;

    if (
      this.chain.chainHead !== null &&
      this.chain.finalizedBlock !== null
    ) {
      this.chain.projectionLag =
        this.chain.chainHead - this.chain.finalizedBlock;
    }
    this.chain.observedAt = now.toISOString();
  }

  /**
   * Compute the full readiness state, separating liveness, startup,
   * readiness, and degraded status. Fails closed on stale, ambiguous,
   * missing, or unauthorized state.
   */
  getReadiness(): {
    state: ReadinessState;
    ready: boolean;
    live: boolean;
    starting: boolean;
    degraded: boolean;
    observedAt: string;
    lastSuccessAt: string | null;
    stale: boolean;
    dependencies: DependencyProvenance[];
    chain: ChainProvenance;
    reasons: string[];
  } {
    const now = new Date();
    this.lastObservedAt = now;
    const reasons: string[] = [];

    const live = true;
    const starting =
      now.getTime() - this.startedAt.getTime() < 5000 ||
      this.lastSuccessAt === null;

    const stale =
      this.lastSuccessAt === null ||
      now.getTime() - this.lastSuccessAt.getTime() > this.STALE_SUCCESS_MS;
    if (stale) reasons.push('stale_last_success');

    const redisConnected = this.redisService.getStatus().connected;
    if (!redisConnected) reasons.push('redis_unavailable');

    const deps = Array.from(this.dependencies.values());
    for (const dep of deps) {
      if (dep.required && dep.status !== 'up') {
        reasons.push(`required_dependency_down:${dep.name}`);
      }
    }

    if (
      this.chain.chainId === null ||
      this.chain.releaseId === null ||
      this.chain.deploymentBlock === null ||
      this.chain.artifactChecksum === null
    ) {
      reasons.push('chain_provenance_incomplete');
    }

    if (
      this.chain.projectionLag !== null &&
      this.chain.projectionLag > this.MAX_PROJECTION_LAG
    ) {
      reasons.push('projection_lag_exceeded');
    }

    const degraded =
      this.failureCount >= this.FAILURE_THRESHOLD ||
      reasons.length > 0;

    const ready =
      !starting &&
      !stale &&
      redisConnected &&
      deps.every((d) => !d.required || d.status === 'up') &&
      this.chain.chainId !== null &&
      this.chain.releaseId !== null &&
      this.chain.deploymentBlock !== null &&
      this.chain.artifactChecksum !== null &&
      (this.chain.projectionLag === null ||
        this.chain.projectionLag <= this.MAX_PROJECTION_LAG);

    let state: ReadinessState;
    if (!live) state = 'not_ready';
    else if (starting) state = 'starting';
    else if (ready) state = 'ready';
    else if (degraded) state = 'degraded';
    else state = 'not_ready';

    return {
      state,
      ready,
      live,
      starting,
      degraded,
      observedAt: now.toISOString(),
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      stale,
      dependencies: deps,
      chain: { ...this.chain },
      reasons,
    };
  }

  /**
   * Public, sanitized readiness status. Never exposes internal error
   * details, stack traces, or dependency detail strings.
   */
  getPublicStatus(): SanitizedReadinessStatus {
    const r = this.getReadiness();
    return {
      state: r.state,
      ready: r.ready,
      live: r.live,
      starting: r.starting,
      degraded: r.degraded,
      observedAt: r.observedAt,
      lastSuccessAt: r.lastSuccessAt,
      stale: r.stale,
      dependencies: r.dependencies.map((d) => ({
        name: d.name,
        status: d.status,
        required: d.required,
      })),
    };
  }

  /**
   * Check if cache is healthy enough to use
   */
  isCacheHealthy(): boolean {
    const status = this.getHealthStatus();
    return status.healthy;
  }

  /**
   * Reset failure counters (called periodically)
   */
  private resetCounters(): void {
    const previousFailures = this.failureCount;
    this.failureCount = 0;
    this.successCount = 0;

    if (previousFailures > 0) {
      this.logger.debug(
        `Reset cache failure counters (previous: ${previousFailures})`,
      );
    }
  }

  /**
   * Start periodic metrics reporting and counter reset
   */
  private startMetricsReporting(): void {
    // Report current health metrics periodically
    setInterval(() => {
      const status = this.getHealthStatus();
      this.metricsService.setGauge('cache_failure_rate', status.failureRate);
      this.metricsService.setGauge('cache_failure_count', status.failureCount);
      this.metricsService.setGauge('cache_success_count', status.successCount);
      this.metricsService.setGauge('cache_healthy', status.healthy ? 1 : 0);

      const readiness = this.getReadiness();
      this.metricsService.setGauge('readiness_ready', readiness.ready ? 1 : 0);
      this.metricsService.setGauge('readiness_stale', readiness.stale ? 1 : 0);
      this.metricsService.setGauge(
        'readiness_degraded',
        readiness.degraded ? 1 : 0,
      );
    }, 5000); // Every 5 seconds

    // Reset counters periodically
    setInterval(() => {
      this.resetCounters();
    }, this.RESET_INTERVAL_MS);
  }
}

// PREWAVE-BE-044: readiness now requires a fresh successful observation.
// Recovery from degraded/not_ready requires recordSuccess() to update
// lastSuccessAt and recordDependency(..., 'up', ...) for required deps.
// Chain provenance must be bound via recordChainProvenance() before ready.
// Public status is sanitized via getPublicStatus().
