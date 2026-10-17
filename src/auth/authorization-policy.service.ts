import {
  Injectable,
  Logger,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

/**
 * Authorization Policy Service
 *
 * Centralizes role/resource ownership checks and deny-by-default
 * across admin, moderation, configuration, and user-scoped endpoints.
 *
 * Implements V2-BE-066: Enforce Least-Privilege API Authorization Policies
 *
 * Also implements PREWAVE-BE-082: Issue Short-Lived Capability Tokens
 * for Protected Operations.
 */

export enum ResourceType {
  CLAIM = 'claim',
  DISPUTE = 'dispute',
  USER = 'user',
  WALLET = 'wallet',
  CONFIG = 'config',
  CONTRACT = 'contract',
  FEATURE_FLAG = 'feature_flag',
  AUDIT_LOG = 'audit_log',
  METRICS = 'metrics',
  SYSTEM = 'system',
}

export enum ActionType {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  MODERATE = 'moderate',
  VERIFY = 'verify',
  REJECT = 'reject',
  ESCALATE = 'escalate',
  DEPLOY = 'deploy',
  PAUSE = 'pause',
  UNPAUSE = 'unpause',
  REVOKE = 'revoke',
  OVERRIDE = 'override',
}

export enum Role {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  MODERATOR = 'moderator',
  ANALYST = 'analyst',
  SUPPORT = 'support',
  USER = 'user',
  SERVICE = 'service',
}

export interface Permission {
  resource: ResourceType;
  action: ActionType;
  conditions?: PolicyCondition[];
}

export interface PolicyCondition {
  type: 'ownership' | 'role' | 'scope' | 'time' | 'ip' | 'custom';
  field?: string;
  operator?: 'equals' | 'in' | 'not_in' | 'contains' | 'gt' | 'lt';
  value?: any;
  customEvaluator?: string; // Name of registered custom evaluator
}

export interface AuthorizationContext {
  userId?: string;
  walletAddress?: string;
  roles: Role[];
  permissions: Permission[];
  resourceId?: string;
  resourceType?: ResourceType;
  action?: ActionType;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  resource: ResourceType;
  actions: ActionType[];
  roles: Role[];
  conditions: PolicyCondition[];
  effect: 'allow' | 'deny';
  priority: number; // Higher = evaluated first
  enabled: boolean;
}

/**
 * Capability Token contract (PREWAVE-BE-082).
 *
 * A capability token is a signed, short-lived, audience-bound assertion
 * that a given subject may perform a specific capability against a specific
 * resource scope, for a specific chain/release/deployment/artifact context.
 */
export interface CapabilityTokenClaims {
  /** Token format version */
  ver: 1;
  /** Audience the token is issued for (e.g. service identifier) */
  aud: string;
  /** Subject (actor) the token is issued to */
  sub: string;
  /** Capability being granted */
  cap: string;
  /** Resource type scope */
  resource: ResourceType;
  /** Optional specific resource identifier */
  resourceId?: string;
  /** Action being authorized */
  action: ActionType;
  /** Unique nonce for replay protection */
  nonce: string;
  /** Issuance time (unix seconds) */
  iat: number;
  /** Expiry time (unix seconds) */
  exp: number;
  /** Chain context */
  chain: string;
  /** Release context */
  release: string;
  /** Deployment context */
  deployment: string;
  /** Artifact provenance digest */
  artifact: string;
}

export interface CapabilityToken {
  claims: CapabilityTokenClaims;
  signature: string;
}

export interface CapabilityIssueRequest {
  aud: string;
  sub: string;
  cap: string;
  resource: ResourceType;
  resourceId?: string;
  action: ActionType;
  ttlSeconds?: number;
  chain?: string;
  release?: string;
  deployment?: string;
  artifact?: string;
}

export interface CapabilityUseRequest {
  token: CapabilityToken;
  aud: string;
  sub: string;
  cap: string;
  resource: ResourceType;
  resourceId?: string;
  action: ActionType;
  chain?: string;
  release?: string;
  deployment?: string;
  artifact?: string;
}

export class CapabilityTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityTokenError';
  }
}

const DEFAULT_CAPABILITY_TTL_SECONDS = 60;
const MAX_CAPABILITY_TTL_SECONDS = 300;
const CAPABILITY_CLOCK_SKEW = 5;
const NONCE_KEY_PREFIX = 'capability:nonce:';
const REVOKED_SUBJECT_KEY_PREFIX = 'capability:revoked:sub:';

/**
 * Authorization Policy Engine
 */
@Injectable()
export class AuthorizationPolicyService {
  private readonly logger = new Logger(AuthorizationPolicyService.name);
  private policies: Map<string, PolicyRule> = new Map();
  private customEvaluators: Map<
    string,
    (context: AuthorizationContext) => Promise<boolean>
  > = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.loadDefaultPolicies();
  }

  /**
   * Load default authorization policies
   */
  private loadDefaultPolicies(): void {
    const defaultPolicies: PolicyRule[] = [
      // SUPER_ADMIN - Full access to everything
      {
        id: 'super-admin-all',
        name: 'Super Admin Full Access',
        description: 'Super admins have unrestricted access to all resources',
        resource: ResourceType.SYSTEM,
        actions: Object.values(ActionType),
        roles: [Role.SUPER_ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 100,
        enabled: true,
      },

      // ADMIN - Most resources except system-level
      {
        id: 'admin-claims',
        name: 'Admin Claim Management',
        description: 'Admins can manage all claims',
        resource: ResourceType.CLAIM,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
          ActionType.ESCALATE,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-disputes',
        name: 'Admin Dispute Management',
        description: 'Admins can manage all disputes',
        resource: ResourceType.DISPUTE,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-users',
        name: 'Admin User Management',
        description: 'Admins can manage users',
        resource: ResourceType.USER,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
          ActionType.REVOKE,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-config',
        name: 'Admin Configuration',
        description: 'Admins can manage configuration',
        resource: ResourceType.CONFIG,
        actions: [
          ActionType.CREATE,
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.DELETE,
          ActionType.LIST,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-contracts',
        name: 'Admin Contract Management',
        description: 'Admins can manage contracts',
        resource: ResourceType.CONTRACT,
        actions: [
          ActionType.READ,
          ActionType.UPDATE,
          ActionType.PAUSE,
          ActionType.UNPAUSE,
        ],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },
      {
        id: 'admin-audit',
        name: 'Admin Audit Access',
        description: 'Admins can read audit logs',
        resource: ResourceType.AUDIT_LOG,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ADMIN],
        conditions: [],
        effect: 'allow',
        priority: 90,
        enabled: true,
      },

      // MODERATOR - Claims and disputes
      {
        id: 'moderator-claims',
        name: 'Moderator Claim Actions',
        description: 'Moderators can moderate claims',
        resource: ResourceType.CLAIM,
        actions: [
          ActionType.READ,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
          ActionType.ESCALATE,
        ],
        roles: [Role.MODERATOR],
        conditions: [],
        effect: 'allow',
        priority: 80,
        enabled: true,
      },
      {
        id: 'moderator-disputes',
        name: 'Moderator Dispute Actions',
        description: 'Moderators can moderate disputes',
        resource: ResourceType.DISPUTE,
        actions: [
          ActionType.READ,
          ActionType.LIST,
          ActionType.MODERATE,
          ActionType.VERIFY,
          ActionType.REJECT,
        ],
        roles: [Role.MODERATOR],
        conditions: [],
        effect: 'allow',
        priority: 80,
        enabled: true,
      },

      // ANALYST - Read-only access to analytics
      {
        id: 'analyst-read',
        name: 'Analyst Read Access',
        description: 'Analysts can read claims, disputes, and metrics',
        resource: ResourceType.CLAIM,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ANALYST],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },
      {
        id: 'analyst-disputes-read',
        name: 'Analyst Dispute Read',
        description: 'Analysts can read disputes',
        resource: ResourceType.DISPUTE,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ANALYST],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },
      {
        id: 'analyst-metrics',
        name: 'Analyst Metrics',
        description: 'Analysts can read metrics',
        resource: ResourceType.METRICS,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.ANALYST],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },

      // SUPPORT - User support operations
      {
        id: 'support-users',
        name: 'Support User Access',
        description: 'Support can view and update user info',
        resource: ResourceType.USER,
        actions: [ActionType.READ, ActionType.UPDATE, ActionType.LIST],
        roles: [Role.SUPPORT],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },
      {
        id: 'support-wallets',
        name: 'Support Wallet Access',
        description: 'Support can view wallet linkages',
        resource: ResourceType.WALLET,
        actions: [ActionType.READ, ActionType.LIST],
        roles: [Role.SUPPORT],
        conditions: [],
        effect: 'allow',
        priority: 70,
        enabled: true,
      },

      // USER - Own resources only
      {
        id: 'user-own-claims',
        name: 'User Own Claims',
        description: 'Users can read and create their own claims',
        resource: ResourceType.CLAIM,
        actions: [ActionType.CREATE, ActionType.READ, ActionType.LIST],
        roles: [Role.USER],
        conditions: [
          { type: 'ownership', field: 'userId', operator: 'equals' },
        ],
        effect: 'allow',
        priority: 60,
        enabled: true,
      },
    ];

    for (const policy of defaultPolicies) {
      this.policies.set(policy.id, policy);
    }
  }

  /**
   * Register a custom policy evaluator.
   */
  registerCustomEvaluator(
    name: string,
    evaluator: (context: AuthorizationContext) => Promise<boolean>,
  ): void {
    this.customEvaluators.set(name, evaluator);
  }

  /**
   * Evaluate whether the context is authorized for the requested action.
   * Deny-by-default: only an explicit allow rule grants access.
   */
  async isAuthorized(context: AuthorizationContext): Promise<boolean> {
    if (!context.resourceType || !context.action) {
      return false;
    }

    const candidates = Array.from(this.policies.values())
      .filter((p) => p.enabled)
      .filter((p) => p.resource === context.resourceType)
      .filter((p) => p.actions.includes(context.action!))
      .filter((p) => p.roles.some((r) => context.roles.includes(r)))
      .sort((a, b) => b.priority - a.priority);

    for (const policy of candidates) {
      const conditionsMet = await this.evaluateConditions(policy.conditions, context);
      if (!conditionsMet) {
        continue;
      }
      if (policy.effect === 'deny') {
        return false;
      }
      return true;
    }

    return false;
  }

  private async evaluateConditions(
    conditions: PolicyCondition[],
    context: AuthorizationContext,
  ): Promise<boolean> {
    for (const condition of conditions) {
      const ok = await this.evaluateCondition(condition, context);
      if (!ok) {
        return false;
      }
    }
    return true;
  }

  private async evaluateCondition(
    condition: PolicyCondition,
    context: AuthorizationContext,
  ): Promise<boolean> {
    switch (condition.type) {
      case 'ownership':
        return this.evaluateOwnership(condition, context);
      case 'role':
        return this.evaluateRole(condition, context);
      case 'scope':
        return true;
      case 'time':
        return this.evaluateTime(condition);
      case 'ip':
        return this.evaluateIp(condition, context);
      case 'custom':
        return this.evaluateCustom(condition, context);
      default:
        return false;
    }
  }

  private evaluateOwnership(
    condition: PolicyCondition,
    context: AuthorizationContext,
  ): boolean {
    const field = condition.field || 'userId';
    const ownerId = context.metadata?.[field] as string | undefined;
    if (!ownerId || !context.userId) {
      return false;
    }
    return ownerId === context.userId;
  }

  private evaluateRole(
    condition: PolicyCondition,
    context: AuthorizationContext,
  ): boolean {
    const required = condition.value as Role | Role[];
    const requiredList = Array.isArray(required) ? required : [required];
    return requiredList.some((r) => context.roles.includes(r));
  }

  private evaluateTime(condition: PolicyCondition): boolean {
    const now = Date.now();
    const value = condition.value as {
      start?: number;
      end?: number;
    } | undefined;
    if (!value) {
      return false;
    }
    if (typeof value.start === 'number' && now < value.start) {
      return false;
    }
    if (typeof value.end === 'number' && now > value.end) {
      return false;
    }
    return true;
  }

  private evaluateIp(
    condition: PolicyCondition,
    context: AuthorizationContext,
  ): boolean {
    const allowed = condition.value as string | string[] | undefined;
    if (!allowed || !context.ipAddress) {
      return false;
    }
    const list = Array.isArray(allowed) ? allowed : [allowed];
    return list.includes(context.ipAddress);
  }

  private async evaluateCustom(
    condition: PolicyCondition,
    context: AuthorizationContext,
  ): Promise<boolean> {
    const name = condition.customEvaluator;
    if (!name) {
      return false;
    }
    const evaluator = this.customEvaluators.get(name);
    if (!evaluator) {
      return false;
    }
    try {
      return await evaluator(context);
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------------------
  // PREWAVE-BE-082: Capability Tokens
  // ----------------------------------------------------------------------------

  /**
   * Issue a signed, short-lived capability token.
   * Authentication alone grants no capability; a token must be explicitly issued.
   */
  async issueCapabilityToken(
    request: CapabilityIssueRequest,
  ): Promise<CapabilityToken> {
    this.assertRequiredString(request.aud, 'aud');
    this.assertRequiredString(request.sub, 'sub');
    this.assertRequiredString(request.cap, 'cap');

    if (!Object.values(ResourceType).includes(request.resource)) {
      throw new CapabilityTokenError('resource_invalid', 'Unknown resource type');
    }
    if (!Object.values(ActionType).includes(request.action)) {
      throw new CapabilityTokenError('action_invalid', 'Unknown action type');
    }

    const ttl = this.resolveTtl(request.ttlSeconds);
    const now = Math.floor(Date.now() / 1000);

    const context = this.resolveContext(request);

    const claims: CapabilityTokenClaims = {
      ver: 1,
      aud: request.aud,
      sub: request.sub,
      cap: request.cap,
      resource: request.resource,
      resourceId: request.resourceId,
      action: request.action,
      nonce: randomBytes(16).toString('hex'),
      iat: now,
      exp: now + ttl,
      chain: context.chain,
      release: context.release,
      deployment: context.deployment,
      artifact: context.artifact,
    };

    const signature = this.signClaims(claims);

    this.logger.log(
      `issued capability token aud=${claims.aud} sub=${claims.sub} cap=${claims.cap} ` +
        `resource=${claims.resource} action=${claims.action} nonce=${claims.nonce} exp=${claims.exp}`,
    );

    return { claims, signature };
  }

  /**
   * Validate and consume a capability token.
   * Fails closed on any mismatch, expiry, replay, or revocation.
   */
  async useCapabilityToken(request: CapabilityUseRequest): Promise<void> {
    const { token } = request;
    if (!token || !token.claims || typeof token.signature !== 'string') {
      this.auditUse('malformed', request);
      throw new CapabilityTokenError('malformed', 'Malformed capability token');
    }

    const claims = token.claims;

    // Signature verification first (fail closed).
    if (!this.verifySignature(claims, token.signature)) {
      this.auditUse('bad-signature', request);
      throw new CapabilityTokenError('bad_signature', 'Invalid token signature');
    }

    if (claims.ver !== 1) {
      this.auditUse('bad-version', request);
      throw new CapabilityTokenError('bad_version', 'Unsupported token version');
    }

    // Audience / subject / capability binding.
    if (claims.aud !== request.aud) {
      this.auditUse('wrong-aud', request);
      throw new CapabilityTokenError('wrong_aud', 'Token audience mismatch');
    }
    if (claims.sub !== request.sub) {
      this.auditUse('wrong-sub', request);
      throw new CapabilityTokenError('wrong_sub', 'Token subject mismatch');
    }
    if (claims.cap !== request.cap) {
      this.auditUse('wrong-cap', request);
      throw new CapabilityTokenError('wrong_cap', 'Token capability mismatch');
    }

    // Resource scope binding.
    if (claims.resource !== request.resource) {
      this.auditUse('wrong-resource', request);
      throw new CapabilityTokenError('wrong_resource', 'Token resource mismatch');
    }
    if ((claims.resourceId ?? undefined) !== (request.resourceId ?? undefined)) {
      this.auditUse('wrong-resource-id', request);
      throw new CapabilityTokenError('wrong_resource_id', 'Token resource id mismatch');
    }
    if (claims.action !== request.action) {
      this.auditUse('wrong-action', request);
      throw new CapabilityTokenError('wrong_action', 'Token action mismatch');
    }

    // Chain/release/deployment/artifact context binding.
    const ctx = this.resolveContext(request);
    if (claims.chain !== ctx.chain) {
      this.auditUse('wrong-chain', request);
      throw new CapabilityTokenError('wrong_chain', 'Token chain context mismatch');
    }
    if (claims.release !== ctx.release) {
      this.auditUse('wrong-release', request);
      throw new CapabilityTokenError('wrong_release', 'Token release context mismatch');
    }
    if (claims.deployment !== ctx.deployment) {
      this.auditUse('wrong-deployment', request);
      throw new CapabilityTokenError('wrong_deployment', 'Token deployment context mismatch');
    }
    if (claims.artifact !== ctx.artifact) {
      this.auditUse('wrong-artifact', request);
      throw new CapabilityTokenError('wrong_artifact', 'Token artifact context mismatch');
    }

    // Temporal validity.
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
      this.auditUse('bad-temporal', request);
      throw new CapabilityTokenError('bad_temporal', 'Token temporal claims invalid');
    }
    if (claims.exp - claims.iat > MAX_CAPABILITY_TTL_SECONDS) {
      this.auditUse('ttl-too-long', request);
      throw new CapabilityTokenError('ttl_too_long', 'Token lifetime exceeds maximum');
    }
    if (now > claims.exp + CAPABILITY_CLOCK_SKEW) {
      this.auditUse('expired', request);
      throw new CapabilityTokenError('expired', 'Token has expired');
    }
    if (now + CAPABILITY_CLOCK_SKEW < claims.iat) {
      this.auditUse('not-yet-valid', request);
      throw new CapabilityTokenError('not_yet_valid', 'Token is not yet valid');
    }

    // Revocation check (fail closed).
    const revoked = await this.redisService.get(
      `${REVOKED_SUBJECT_KEY_PREFIX}${claims.sub}`,
    );
    if (revoked) {
      this.auditUse('revoked-subject', request);
      throw new CapabilityTokenError('revoked', 'Token subject has been revoked');
    }

    // Replay protection: atomically claim the nonce.
    const nonceKey = `${NONCE_KEY_PREFIX}${claims.nonce}`;
    const ttl = Math.max(1, claims.exp - now + CAPABILITY_CLOCK_SKEW);
    const claimed = await this.redisService.setIfNotExists(nonceKey, '1', ttl);
    if (!claimed) {
      this.auditUse('replay', request);
      throw new CapabilityTokenError('replay', 'Token has already been used');
    }

    this.auditUse('ok', request);
  }

  /**
   * Revoke all capability tokens for a subject.
   */
  async revokeSubject(sub: string, ttlSeconds?: number): Promise<void> {
    this.assertRequiredString(sub, 'sub');
    const ttl = this.resolveTtl(ttlSeconds);
    await this.redisService.set(
      `${REVOKED_SUBJECT_KEY_PREFIX}${sub}`,
      '1',
      ttl,
    );
    this.logger.log(`revoked capability tokens for subject=${sub}`);
  }

  private resolveTtl(ttlSeconds?: number): number {
    const requested = ttlSeconds ?? undefined;
    if (requested === undefined) {
      return DEFAULT_CAPABILITY_TTL_SECONDS;
    }
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new CapabilityTokenError('bad_ttl', 'TTL must be a positive number');
    }
    return Math.min(Math.floor(requested), MAX_CAPABILITY_TTL_SECONDS);
  }

  private resolveContext(request: {
    chain?: string;
    release?: string;
    deployment?: string;
    artifact?: string;
  }): { chain: string; release: string; deployment: string; artifact: string } {
    const chain = request.chain ?? '';
    const release = request.release ?? '';
    const deployment = request.deployment ?? '';
    const artifact = request.artifact ?? '';
    if (!chain || !release || !deployment || !artifact) {
      throw new CapabilityTokenError(
        'missing_context',
        'Chain, release, deployment, and artifact context are required',
      );
    }
    return { chain, release, deployment, artifact };
  }

  private assertRequiredString(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new CapabilityTokenError(
        'missing_field',
        `Required field '${field}' is missing`,
      );
    }
  }

  private getSigningKey(): string {
    const key = this.configService.get<string>('CAPABILITY_TOKEN_SIGNING_KEY');
    if (!key) {
      throw new CapabilityTokenError(
        'missing_signing_key',
        'Capability token signing key is not configured',
      );
    }
    return key;
  }

  private canonicalizeClaims(claims: CapabilityTokenClaims): string {
    return JSON.stringify({
      ver: claims.ver,
      aud: claims.aud,
      sub: claims.sub,
      cap: claims.cap,
      resource: claims.resource,
      resourceId: claims.resourceId ?? null,
      action: claims.action,
      nonce: claims.nonce,
      iat: claims.iat,
      exp: claims.exp,
      chain: claims.chain,
      release: claims.release,
      deployment: claims.deployment,
      artifact: claims.artifact,
    });
  }

  private signClaims(claims: CapabilityTokenClaims): string {
    return createHmac('sha256', this.getSigningKey())
      .update(this.canonicalizeClaims(claims))
      .digest('hex');
  }

  private verifySignature(claims: CapabilityTokenClaims, signature: string): boolean {
    try {
      const expected = this.signClaims(claims);
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(signature, 'hex');
      if (a.length !== b.length) {
        return false;
      }
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private auditUse(outcome: string, request: CapabilityUseRequest): void {
    const claims = request.token?.claims;
    this.logger.log(
      `capability token use outcome=${outcome} aud=${request.aud} sub=${request.sub} ` +
        `cap=${request.cap} resource=${request.resource} action=${request.action} ` +
        `nonce=${claims?.nonce ?? '-'}`,
    );
  }
}

/**
 * Guard that requires a valid capability token on the request.
 */
@Injectable()
export class CapabilityTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policyService: AuthorizationPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const requirement = this.reflector.get<{
      aud: string;
      cap: string;
      resource: ResourceType;
      action: ActionType;
    }>('capability', context.getHandler());
    if (!requirement) {
      throw new ForbiddenException('Capability requirement missing');
    }
    const token = request.body?.capabilityToken as CapabilityToken | undefined;
    const sub = request.user?.id as string | undefined;
    if (!token || !sub) {
      throw new ForbiddenException('Missing capability token or subject');
    }
    try {
      await this.policyService.useCapabilityToken({
        token,
        aud: requirement.aud,
        sub,
        cap: requirement.cap,
        resource: requirement.resource,
        resourceId: request.params?.id as string | undefined,
        action: requirement.action,
        chain: request.body?.chain,
        release: request.body?.release,
        deployment: request.body?.deployment,
        artifact: request.body?.artifact,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Capability token rejected';
      throw new ForbiddenException(message);
    }
  }
}
