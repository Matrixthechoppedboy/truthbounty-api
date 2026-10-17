import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { AdminAuditLog } from '../entities/admin-audit-log.entity';
import { AdminAuditHead } from '../entities/admin-audit-head.entity';
import {
  AdminActionType,
  AdminActionCategory,
  AdminAuditSeverity,
  AdminAuditLogInput,
  AdminAuditOutcome,
} from '../admin-audit.types';
export * from '../admin-audit.types';
export type AdminAuditLogRecord = AdminAuditLog;

export interface AdminAuditQueryFilters {
  actorId?: string;
  correlationId?: string;
  action?: AdminActionType;
  outcome?: AdminAuditOutcome;
  page?: number;
  limit?: number;
}
export interface AdminAuditQueryResult {
  logs: AdminAuditLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_.:-]{0,95}$/i;
const OUTCOMES: AdminAuditOutcome[] = [
  'attempted',
  'success',
  'failure',
  'partial',
  'rolled_back',
  'unknown',
];

/** Database-only operations must use the supplied manager; external effects need an outbox. */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
  ) {}

  async log(
    input: AdminAuditLogInput,
    manager?: EntityManager,
  ): Promise<string> {
    this.assertPostgres();
    const safe = this.sanitize(input);
    if (manager) {
      if (
        manager.connection !== this.source ||
        !manager.queryRunner?.isTransactionActive
      ) {
        throw new Error(
          'Audit writes require this datasource and an active transaction',
        );
      }
      return this.append(safe, manager);
    }
    return this.source.transaction((tx) => this.append(safe, tx));
  }

  async logBatch(inputs: AdminAuditLogInput[]): Promise<string[]> {
    this.assertPostgres();
    const safe = inputs.map((input) => this.sanitize(input));
    return this.source.transaction(async (tx) => {
      const ids: string[] = [];
      for (const input of safe) ids.push(await this.append(input, tx));
      return ids;
    });
  }

  /** A durable attempt precedes execution; success shares the operation's commit. */
  async execute<T>(
    input: Omit<AdminAuditLogInput, 'outcome'>,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<{ result: T; eventId: string }> {
    // Copy/validate before invoking caller code, which must not mutate audit context.
    const context = this.sanitize({ ...input, outcome: 'attempted' });
    await this.log(context);
    const runner = this.source.createQueryRunner();
    let committing = false;
    try {
      await runner.connect();
      await runner.startTransaction();
      const result = await work(runner.manager);
      const eventId = await this.append(
        { ...context, outcome: 'success' },
        runner.manager,
      );
      committing = true;
      await runner.commitTransaction();
      return { result, eventId };
    } catch (error) {
      let outcome: AdminAuditOutcome = 'unknown';
      if (runner.isTransactionActive) {
        try {
          await runner.rollbackTransaction();
          // A lost COMMIT acknowledgement cannot establish whether it committed.
          if (!committing) outcome = 'rolled_back';
        } catch {
          // Keep the durable attempt; never report success or invent rollback proof.
        }
      }
      await this.log({ ...context, outcome });
      throw error;
    } finally {
      await runner.release();
    }
  }

  async query(filters: AdminAuditQueryFilters): Promise<AdminAuditQueryResult> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger((page - 1) * limit)
    ) {
      throw new Error('Invalid audit pagination');
    }
    const query = this.source
      .getRepository(AdminAuditLog)
      .createQueryBuilder('audit');
    for (const key of [
      'actorId',
      'correlationId',
      'action',
      'outcome',
    ] as const) {
      if (filters[key] !== undefined)
        query.andWhere(`audit.${key} = :${key}`, { [key]: filters[key] });
    }
    const [logs, total] = await query
      .orderBy('audit.chainSequence', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  getByEventId(eventId: string): Promise<AdminAuditLog | null> {
    return this.source.getRepository(AdminAuditLog).findOneBy({ eventId });
  }

  async getStats(): Promise<Record<string, number>> {
    const rows: { outcome: string; count: string }[] = await this.source
      .getRepository(AdminAuditLog)
      .createQueryBuilder('audit')
      .select('audit.outcome', 'outcome')
      .addSelect('COUNT(*)', 'count')
      .groupBy('audit.outcome')
      .getRawMany();
    return Object.fromEntries(
      rows.map((row) => [row.outcome, Number(row.count)]),
    );
  }

  /** One consistent snapshot, including the persisted tip, detects gaps and tail loss. */
  async verifyIntegrity(): Promise<{
    valid: boolean;
    checked: number;
    firstInvalid?: string;
    errors: string[];
  }> {
    this.assertPostgres();
    return this.source.transaction('REPEATABLE READ', async (tx) => {
      const head = await tx.findOneByOrFail(AdminAuditHead, { id: 1 });
      let sequence = 0n;
      let previousHash: string | null = null;
      let checked = 0;
      for (;;) {
        const rows = await tx
          .getRepository(AdminAuditLog)
          .createQueryBuilder('audit')
          .where('audit.chainSequence > :sequence', {
            sequence: sequence.toString(),
          })
          .orderBy('audit.chainSequence', 'ASC')
          .take(500)
          .getMany();
        if (!rows.length) break;
        for (const row of rows) {
          checked++;
          if (
            BigInt(row.chainSequence) !== sequence + 1n ||
            row.previousHash !== previousHash ||
            row.integrityHash !== this.hash(row)
          ) {
            return {
              valid: false,
              checked,
              firstInvalid: row.eventId,
              errors: ['Audit chain integrity mismatch'],
            };
          }
          sequence = BigInt(row.chainSequence);
          previousHash = row.integrityHash;
        }
      }
      const valid =
        sequence.toString() === head.lastSequence &&
        previousHash === head.lastHash;
      return {
        valid,
        checked,
        errors: valid ? [] : ['Audit chain tip mismatch'],
      };
    });
  }

  private async append(
    input: AdminAuditLogInput,
    tx: EntityManager,
  ): Promise<string> {
    const head = await tx
      .getRepository(AdminAuditHead)
      .findOneOrFail({ where: { id: 1 }, lock: { mode: 'pessimistic_write' } });
    const timestamp = new Date();
    const days = Number(
      this.config.get<string>('ADMIN_AUDIT_RETENTION_DAYS') ?? 365,
    );
    if (!Number.isInteger(days) || days < 1 || days > 3650)
      throw new Error('Invalid administrative audit retention');
    const record = tx.create(AdminAuditLog, {
      ...input,
      eventId: randomUUID(),
      chainSequence: (BigInt(head.lastSequence) + 1n).toString(),
      timestamp,
      retentionUntil: new Date(timestamp.getTime() + days * 86_400_000),
      resultReference: input.resultReference ?? null,
      chainContext: input.chainContext ?? null,
      severity: input.severity ?? AdminAuditSeverity.MEDIUM,
      previousHash: head.lastHash,
    });
    record.integrityHash = this.hash(record);
    await tx.insert(AdminAuditLog, record);
    await tx.update(
      AdminAuditHead,
      { id: 1 },
      { lastSequence: record.chainSequence, lastHash: record.integrityHash },
    );
    return record.eventId;
  }

  /** Deliberate allowlist: raw states, reasons, errors, headers and metadata never enter storage/logs. */
  private sanitize(input: AdminAuditLogInput): AdminAuditLogInput {
    for (const value of [
      input.actorId,
      input.targetId,
      input.authorityReference,
      input.requestReference,
      input.correlationId,
    ]) {
      if (typeof value !== 'string' || !UUID.test(value))
        throw new Error('Audit references must be UUIDs');
    }
    if (
      input.resultReference !== undefined &&
      !UUID.test(input.resultReference)
    )
      throw new Error('Invalid audit result reference');
    if (
      !CODE.test(input.capability) ||
      !CODE.test(input.targetType) ||
      typeof input.capability !== 'string' ||
      typeof input.targetType !== 'string'
    )
      throw new Error('Invalid audit capability or target type');
    if (
      !['user', 'service', 'system'].includes(input.actorType) ||
      !['rbac', 'policy', 'service', 'chain'].includes(input.authoritySource) ||
      !OUTCOMES.includes(input.outcome) ||
      !Object.values(AdminActionType).includes(input.action) ||
      !Object.values(AdminActionCategory).includes(input.actionCategory) ||
      (input.severity !== undefined &&
        !Object.values(AdminAuditSeverity).includes(input.severity))
    )
      throw new Error('Invalid audit classification');
    let chainContext: AdminAuditLogInput['chainContext'];
    if (input.authoritySource === 'chain' && !input.chainContext)
      throw new Error('Chain authority requires release context');
    if (input.chainContext) {
      const c = input.chainContext;
      if (
        !Number.isSafeInteger(c.chainId) ||
        c.chainId <= 0 ||
        !UUID.test(c.releaseId) ||
        !/^(0|[1-9][0-9]{0,19})$/.test(c.deploymentBlock) ||
        !/^0x[0-9a-f]{64}$/i.test(c.artifactChecksum)
      )
        throw new Error('Invalid chain audit context');
      chainContext = {
        chainId: c.chainId,
        releaseId: c.releaseId,
        deploymentBlock: c.deploymentBlock,
        artifactChecksum: c.artifactChecksum,
      };
    }
    return {
      actorId: input.actorId,
      actorType: input.actorType,
      action: input.action,
      actionCategory: input.actionCategory,
      targetType: input.targetType,
      targetId: input.targetId,
      capability: input.capability,
      authoritySource: input.authoritySource,
      authorityReference: input.authorityReference,
      requestReference: input.requestReference,
      resultReference: input.resultReference,
      correlationId: input.correlationId,
      outcome: input.outcome,
      severity: input.severity,
      chainContext,
    };
  }

  private hash(row: AdminAuditLog): string {
    const data: Partial<AdminAuditLog> = { ...row };
    delete data.integrityHash;
    // All nested fields have a fixed shape; canonicalize JSONB key ordering too.
    const canonical = (value: unknown): string => {
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      if (value !== null && typeof value === 'object') {
        return (
          '{' +
          Object.keys(value)
            .sort()
            .map(
              (key) =>
                JSON.stringify(key) +
                ':' +
                canonical((value as Record<string, unknown>)[key]),
            )
            .join(',') +
          '}'
        );
      }
      return JSON.stringify(value);
    };
    return createHash('sha256').update(canonical(data)).digest('hex');
  }

  private assertPostgres(): void {
    if (this.source.options.type !== 'postgres')
      throw new Error('Administrative audit persistence requires PostgreSQL');
  }
}
