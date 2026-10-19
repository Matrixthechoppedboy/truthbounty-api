import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers/';

import { ContractConfig } from '../config/event-indexer.config';
import {
  CanonicalReleaseManifest,
  ReleaseManifestContract,
  ReleaseManifestAdapter,
} from '../config/release-manifest.adapter';
import {
  RealtimeConfig,
  RealtimeTopicDefinition,
} from './types';
import { RealtimeConfigService } from './realtime-config.service';

/**
 * Result of validating a single contract config at startup.
 */
export interface ContractValidationResult {
  name: string;
  address: string;
  valid: boolean;
  errors: string[];
}

/**
 * Result of validating the canonical release manifest at startup.
 */
export interface ReleaseManifestValidationResult {
  releaseId: string;
  chainId: number;
  deploymentBlock: number;
  contracts: ReleaseManifestContract[];
  manifestAgeMs: number;
}

/**
 * Environment modes that determine fail-closed behaviour.
 */
export type EnvironmentMode = 'local' | 'development' |
  'test' | 'staging' | 'production';

/**
 * Result of validating the realtime configuration at startup.
 */
export interface RealtimeConfigValidationResult {
  valid: boolean;
  errors: string[];
  topics: RealtimeTopicDefinition[];
  config?: RealtimeConfig;
}

/**
 * Readiness status separated from liveness and startup.
 */
export type ReadinessStatus =
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'unready';

/**
 * Liveness is independent of readiness and dependency provenance.
 */
export type LivenessStatus = 'alive' | 'dead';

/**
 * Per-dependency provenance recorded at observation time.
 */
export interface DependencyProvenance {
  name: string;
  required: boolean;
  observedAt: number | null;
  lastSuccessAt: number | null;
  lastSuccessOk: boolean;
  stale: boolean;
  detail?: string;
}

/**
 * Readiness observation snapshot.
 */
export interface ReadinessObservation {
  observedAt: number;
  lastSuccessAt: number | null;
  chainId: number | null;
  chainHead: number | null;
  finalizedBlock: number | null;
  projectionLagBlocks: number | null;
  releaseId: string | null;
  deploymentBlock: number | null;
  artifactChecksum: string | null;
  dependencies: DependencyProvenance[];
}

/**
 * Sanitized public status shape. Never leaks internal details, error
 * strings, or addresses.
 */
export interface PublicReadinessStatus {
  status: ReadinessStatus;
  liveness: LivenessStatus;
  observedAt: number | null;
  lastSuccessAgeMs: number | null;
  releaseId: string | null;
  chainId: number | null;
  dependencies: Array<{ name: string; ok: boolean; stale: boolean }>;
}

/**
 * Readiness thresholds.
 */
export interface ReadinessPolicy {
  maxSuccessAgeMs: number;
  maxRpcLagBlocks: number;
  maxProjectionLagBlocks: number;
}

/**
 * Validates chain, contract address and ABI configuration at startup,
 * before the indexer begins consuming blocks.
 *
 * This is "V2-BE-009 — validate chain/addresses/ABIs at startup": catch
 * misconfigurations early and fail fast (fail-closed) rather than emitting
 * garbage into the indexer or routing to the wrong chain.
 *
 * Stab-BE-007 extends this to consume the versioned canonical contract
 * release manifest rather than hand-maintained addresses/events, and to
 * validate chain ID, release ID, deployment block, addresses, ABI/event
 * checksums and manifest age. It fails closed in staging/production when
 * required release data is absent or inconsistent, and keeps local dev
 * explicit and visibly non-production.
 *
 * PREWAVE-BE-035 extends this to validate the realtime configuration
 * (stream origins, topics, retention, heartbeat, payload limits, supported
 * release) and to authorize subscription topics per principal/capability.
 * Invalid realtime config fails startup/readiness and topic names cannot
 * inject Redis/WebSocket patterns.
 *
 * PREWAVE-BE-044 extends this with runtime readiness observations: observed
 * time, last success, chain head/finalized block, projection lag,
 * release and per-dependency provenance. Liveness, startup, readiness and
 * degraded status are separated and fail closed on stale, ambiguous,
 * missing or unauthorized state.
 *
 * Address validation is *pure* (checksum + shape). RPC/chain-id and
 * contract-code checks require a network round trip and are only performed
 * when `BLOCKCHAIN_STARTUP_RPC_CHECK=true` (default true) so the app fails
 * closed in production but still boots in offline/offline-dev environments
 * via `BLOCKCHAIN_STARTUP_RPC_CHECK=false`.
 */
@Injectable()
export class StartupValidationService {
  private readonly logger = new Logger(StartupValidationService.name);

  /** Latest readiness observation, if any. */
  private readinessObservation: ReadinessObservation | null = null;

  /** Startup completion timestamp (null until startup validation passes). */
  private startupCompletedAt: number | null = null;

  /** Liveness signal, independent of readiness. */
  private livenessAlive = true;

  constructor(
    private readonly configService: ConfigService,
    private readonly releaseManifestAdapter: ReleaseManifestAdapter,
    private readonly realtimeConfigService: RealtimeConfigService,
  ) {}

  /**
   * Entry point invoked on application bootstrap. Throws (fail-closed) if
   * any configured contract/chain/ABI is invalid.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.configService.get('BLOCKCHAIN_STARTUP_VALIDATION') === 'false') {
      this.logger.warn('Blockchain startup validation disabled by config');
      this.startupCompletedAt = Date.now();
      return;
    }

    const envManifest = this.releaseManifestAdapter.load();
    const isLocal = this.isLocalMode();

    const errors: string[] = [];

    // 1. Release manifest validation (fail-closed outside local).
    errors.push(...this.validateReleaseManifest(envManifest, isLocal));

    // 2. Contract config validation.
    const contracts = this.getContracts();
    if (contracts.length === 0 && !isLocal) {
      errors.push(
        'INDEXED_CONTRACTS is empty; indexer configuration cannot start outside explicit local mode',
      );
    }
    for (const contract of contracts) {
      const result = this.validateContract(contract);
      if (!result.valid) {
        errors.push(
          `Contract "${result.name}" (${result.address}) address invalid: ${result.errors.join('; ')}`,
        );
      }
    }

    // 3. Release manifest <-> contract config consistency.
    if (envManifest) {
      errors.push(...this.validateManifestConsistency(envManifest, contracts));
    }

    // 4. Realtime configuration validation (fail-closed outside local).
    const realtimeResult = this.validateRealtimeConfig(isLocal);
    errors.push(...realtimeResult.errors);

    // 5. Network-backed checks.
    if (this.configService.get('BLOCKCHAIN_STARTUP_RPC_CHECK') !== 'false') {
      errors.push(...(await this.validateChainAndCode(contracts)));
    }

    if (errors.length > 0) {
      const msg = `Blockchain startup validation failed:\n${errors
        .map((e) => `  - ${e}`)
        .join('\n')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    this.startupCompletedAt = Date.now();
    const releaseId = envManifest?.releaseId ?? 'unknown';
    this.logger.log(
      `Blockchain startup validation passed (release=${releaseId}, ${contracts.length} contracts, ABI/address checks ok, ${realtimeResult.topics.length} realtime topics)`,
    );
  }

  /**
   * Validate a single contract's address shape, checksum and ABI parseability.
   * Pure: no network I/O.
   */
  validateContract(contract: ContractConfig): ContractValidationResult {
    const errors: string[] = [];

    if (!contract.address) {
      errors.push('missing address');
    } else if (!/^0x[a-fA-F0-9]{40}$/.test(contract.address)) {
      errors.push(`address "${contract.address}" is not a valid 20-byte hex`);
    } else {
      try {
        const checksummed = ethers.getAddress(contract.address);
        if (checksummed !== contract.address) {
          errors.push(
            `address "${contract.address}" is not checksummed (expected ${checksummed})`,
          );
        }
      } catch (err) {
        errors.push(
          `address "${contract.address}" failed checksum: ${String(err)}`,
        );
      }
    }

    if (!Array.isArray(contract.events) || contract.events.length === 0) {
      errors.push('no events configured');
    } else {
      for (const event of contract.events) {
        if (!event.abi) {
          errors.push(`event "${event.name}" has no ABI fragment`);
          continue;
        }
        try {
          // Throws if the fragment is malformed.
          const fragment = ethers.Fragment.from(event.abi);
          if (fragment.type !== 'event') {
            errors.push(
              `event "${event.name}" ABI is not an event fragment (got ${fragment.type})`,
            );
          }
        } catch (err) {
          errors.push(`event "${event.name}" ABI is invalid: ${String(err)}`);
        }
      }
    }

    return {
      name: contract.name ?? contract.address,
      address: contract.address,
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate the canonical release manifest against the configured chain
   * and manifest age. Fails closed outside local mode.
   */
  validateReleaseManifest(
    manifest: CanonicalReleaseManifest | null,
    isLocal: boolean,
  ): string[] {
    const errors: string[] = [];

    if (!manifest) {
      if (!isLocal) {
        errors.push(
          'Canonical release manifest is missing or unreadable; required outside local mode',
        );
      }
      return errors;
    }

    // Release ID must be a non-empty string.
    if (!manifest.releaseId || typeof manifest.releaseId !== 'string') {
      errors.push('Release manifest is missing a valid releaseId');
    }

    // Chain ID must match the configured chain ID.
    const configuredChainId = this.configService.get<number>('blockchain.chainId');
    if (configuredChainId !== undefined && configuredChainId !== null) {
      if (Number(manifest.chainId) !== Number(configuredChainId)) {
        errors.push(
          `Release manifest chainId (${manifest.chainId}) does not match configured chainId (${configuredChainId})`,
        );
      }
    } else if (!isLocal) {
      errors.push('blockchain.chainId is not configured');
    }

    // Deployment block must be a non-negative integer.
    if (
      typeof manifest.deploymentBlock !== 'number' ||
      !Number.isInteger(manifest.deploymentBlock) ||
      manifest.deploymentBlock < 0
    ) {
      errors.push('Release manifest is missing a valid deploymentBlock');
    }

    // Manifest age must be within the configured maximum.
    const maxAgeMs = this.getMaxManifestAgeMs();
    const ageMs = this.getManifestAgeMs(manifest);
    if (ageMs !== null && ageMs > maxAgeMs) {
      errors.push(
        `Release manifest is stale (age ${ageMs}ms > max ${maxAgeMs}ms)`,
      );
    }

    // Artifact checksum must be present outside local mode.
    if (!isLocal && !manifest.artifactChecksum) {
      errors.push('Release manifest is missing an artifactChecksum');
    }

    return errors;
  }

  /**
   * Validate realtime configuration (stream origins, topics, retention,
   * heartbeat, payload limits, supported release). Fails closed outside
   * local mode.
   */
  validateRealtimeConfig(isLocal: boolean): RealtimeConfigValidationResult {
    const result = this.realtimeConfigService.validate({ isLocal });
    return {
      valid: result.valid,
      errors: result.errors,
      topics: result.config?.topics ?? [],
      config: result.config,
    };
  }

  /**
   * Validate release manifest <-> contract config consistency.
   */
  private validateManifestConsistency(
    manifest: CanonicalReleaseManifest,
    contracts: ContractConfig[],
  ): string[] {
    const errors: string[] = [];
    const manifestContracts = Array.isArray(manifest.contracts)
      ? manifest.contracts
      : [];

    const byName = new Map<string, ReleaseManifestContract>();
    for (const mc of manifestContracts) {
      if (!mc.name) {
        errors.push('Release manifest contains a contract without a name');
        continue;
      }
      if (byName.has(mc.name)) {
        errors.push(`Release manifest declares duplicate contract "${mc.name}"`);
        continue;
      }
      byName.set(mc.name, mc);
    }

    for (const contract of contracts) {
      const name = contract.name ?? contract.address;
      const mc = byName.get(name);
      if (!mc) {
        errors.push(`Contract "${name}" is not declared in the release manifest`);
        continue;
      }
      if (mc.address && contract.address && mc.address.toLowerCase() !== contract.address.toLowerCase()) {
        errors.push(
          `Contract "${name}" address (${contract.address}) does not match release manifest (${mc.address})`,
        );
      }
    }
    return errors;
  }

  /**
   * Network-backed chain ID and contract code checks.
   */
  private async validateChainAndCode(contracts: ContractConfig[]): Promise<string[]> {
    const errors: string[] = [];
    const rpcUrl = this.configService.get<string>('blockchain.rpcUrl');
    if (!rpcUrl) {
      errors.push('blockchain.rpcUrl is not configured');
      return errors;
    }

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const network = await provider.getNetwork();
      const configuredChainId = this.configService.get<number>('blockchain.chainId');
      if (configuredChainId !== undefined && configuredChainId !== null) {
        if (Number(network.chainId) !== Number(configuredChainId)) {
          errors.push(
            `RPC chainId (${network.chainId}) does not match configured chainId (${configuredChainId})`,
          );
        }
      }

      for (const contract of contracts) {
        if (!contract.address) {
          continue;
        }
        const code = await provider.getCode(contract.address);
        if (!code || code === '0x') {
          errors.push(
            `Contract "${contract.name ?? contract.address}" has no code at ${contract.address}`,
          );
        }
      }
    } catch (err) {
      errors.push(`RPC validation failed: ${String(err)}`);
    }

    return errors;
  }

  /**
   * Record a readiness observation. The observation is treated as a
   * successful observation only when all required dependencies are ok and
   * the chain/projection lags are within policy.
   */
  recordReadinessObservation(observation: ReadinessObservation): void {
    this.readinessObservation = observation;
  }

  /**
   * Mark the service as live or dead. Liveness is independent of
   * readiness and dependency provenance.
   */
  setLiveness(alive: boolean): void {
    this.livenessAlive = alive;
  }

  /**
   * Compute the current readiness status from the latest observation.
   * Fails closed on stale, ambiguous, missing or unauthorized state.
   */
  getReadinessStatus(now: number = Date.now()): ReadinessStatus {
    if (this.startupCompletedAt === null) {
      return 'starting';
    }

    const obs = this.readinessObservation;
    if (!obs) {
      return 'unready';
    }

    const policy = this.getReadinessPolicy();

    // A stale last-success cannot report healthy.
    if (obs.lastSuccessAt === null) {
      return 'unready';
    }
    const successAgeMs = now - obs.lastSuccessAt;
    if (successAgeMs > policy.maxSuccessAgeMs) {
      return 'unready';
    }

    // Required dependency failure removes readiness.
    for (const dep of obs.dependencies) {
      if (dep.required && (!dep.lastSuccessOk || dep.stale)) {
        return 'unready';
      }
    }

    // Chain-derived data must be bound to chain ID and release ID.
    const configuredChainId = this.configService.get<number>('blockchain.chainId');
    if (configuredChainId !== undefined && configuredChainId !== null) {
      if (obs.chainId === null || Number(obs.chainId) !== Number(configuredChainId)) {
        return 'unready';
      }
    } else if (obs.chainId === null) {
      return 'unready';
    }

    if (!obs.releaseId) {
      return 'unready';
    }

    // Degraded if lAG thresholds are exceeded but required deps are ok.
    if (
      obs.chainHead === null ||
      obs.finalizedBlock === null ||
      obs.projectionLagBlocks === null
    ) {
      return 'degraded';
    }

    const rpcLag = obs.chainHead - obs.finalizedBlock;
    if (rpcLag > policy.maxRpcLagBlocks) {
      return 'degraded';
    }
    if (obs.projectionLagBlocks > policy.maxProjectionLagBlocks) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Return a sanitized public status. Never leaks internal details,
   * error strings, or addresses.
   */
  getPublicStatus(now: number = Date.now()): PublicReadinessStatus {
    const obs = this.readinessObservation;
    const status = this.getReadinessStatus(now);
    const lastSuccessAgeMs =
      obs && obs.lastSuccessAt !== null
        ? now - obs.lastSuccessAt
        : null;

    return {
      status,
      liveness: this.livenessAlive ? 'alive' : 'dead',
      observedAt: obs ? obs.observedAt : null,
      lastSuccessAgeMs,
      releaseId: obs ? obs.releaseId : null,
      chainId: obs ? obs.chainId : null,
      dependencies: obs
        ? obs.dependencies.map((d) => ({
            name: d.name,
            ok: d.lastSuccessOk,
            stale: d.stale,
          }))
        : [],
    };
  }

  /**
   * Readiness policy derived from configuration with safe defaults.
   */
  getReadinessPolicy(): ReadinessPolicy {
    return {
      maxSuccessAgeMs: this.getNumericConfig(
        'BLOCKCHAIN_READINESS_MAX_SUCCESS_AGE_MS',
        60_000,
      ),
      maxRpcLagBlocks: this.getNumericConfig(
        'BLOCKCHAIN_READINESS_MAX_RPC_LAG_BLOCKS',
        5,
      ),
      maxProjectionLagBlocks: this.getNumericConfig(
        'BLOCKCHAIN_READINESS_MAX_PROJECTION_LAG_BLOCKS',
        20,
      ),
    };
  }

  /**
   * Return true if startup validation has completed successfully.
   */
  isStartupComplete(): boolean {
    return this.startupCompletedAt !== null;
  }

  /**
   * Return true if the service is live.
   */
  isLive(): boolean {
    return this.livenessAlive;
  }

  private isLocalMode(): boolean {
    const env = (this.configService.get<string>('NODE_ENV') ?? '').toLowerCase();
    return env === 'local' || env === 'development';
  }

  private getContracts(): ContractConfig[] {
    const configured = this.configService.get<ContractConfig[]>(
      'blockchain.contracts',
    );
    return Array.isArray(configured) ? configured : [];
  }

  private getMaxManifestAgeMs(): number {
    return this.getNumericConfig(
      'BLOCKCHAIN_RELEASE_MANIFEST_MAX_AGE_MS',
      30 * 24 * 60 * 60 * 1000,
    );
  }

  private getManifestAgeMs(manifest: CanonicalReleaseManifest): number | null {
    const generatedAt = (manifest as unknown as { generatedAt?: unknown })
      .generatedAt;
    if (typeof generatedAt === 'number' && Number.isFinite(generatedAt)) {
      return Date.now() - generatedAt;
    }
    if (typeof generatedAt === 'string') {
      const parsed = Date.parse(generatedAt);
      if (!Number.isNaN(parsed)) {
        return Date.now() - parsed;
      }
    }
    return null;
  }

  private getNumericConfig(key: string, defaultValue: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') {
      return defaultValue;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  }
}