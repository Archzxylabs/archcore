import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { LogController } from 'fastify';
import { RentalManagerClient } from '@archcore/chain';
import { ArchcoreError, ErrorCode, protocolError, toSafeError, DEFAULT_RPC_URL } from '@archcore/shared';
import type { ChainRental } from '@archcore/shared';
import { loadAuthoritativeRental, assertRentalIsActiveForNode } from './rentalGuard.js';
import type { AgentConfig } from './config.js';
import type { InferenceBackendAdapter } from './adapter.js';
import { BlockedInferenceBackendAdapter, DemoInferenceBackend } from './adapter.js';
import type { HealthMonitor } from './health.js';
import type { SessionStore } from './sessionStore.js';
import { loadRuntimeConfig, validateAndResolveSettlementDbPath } from './config.js';
import { createLogger } from './logger.js';
import { AuthError, ChallengeStore, typedDataPayload, verifyChallenge, buildDomain, SIGN_TYPES } from './auth.js';
import { ReservationWatcher } from './reservationWatcher.js';
import { InferenceClient, InferenceError } from './inference.js';
import { RentalQuota } from './quota.js';
import { serveStatic, DEFAULT_WEB_ROOT } from './static.js';
import { HealthMonitor as HealthMonitorImpl } from './health.js';
import { SessionStore as SessionStoreImpl } from './sessionStore.js';
import { SqliteSettlementJournal } from './journal/index.js';
import type { SettlementJournal } from './journal/index.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything the server needs at runtime. Production passes nothing and gets
 * the real singletons; tests pass fakes so a route can be exercised without a
 * chain connection, a backend socket or an nvidia GPU.
 */
export interface AgentDeps {
  config: AgentConfig;
  logger: ReturnType<typeof createLogger>;
  rentalClient: RentalManagerClient;
  backend: InferenceBackendAdapter;
  healthMonitor: HealthMonitor;
  inference: InferenceClient;
  sessions: SessionStore;
  challenges: ChallengeStore;
  quota: RentalQuota;
  watcher: ReservationWatcher;
  journal?: SettlementJournal;
}

function defaultDeps(): AgentDeps {
  const config: AgentConfig = loadRuntimeConfig();
  // PRD v0.5: Explicit Demo Inference Backend when INFERENCE_BACKEND_MODE=demo.
  const backend: InferenceBackendAdapter =
    config.inferenceMode === 'demo'
      ? new DemoInferenceBackend()
      : new BlockedInferenceBackendAdapter(
          'Operator OmniRoute/backend configuration not provided (missing: ingress route, backend endpoint, stream protocol, model identifier)',
        );
  const rentalClient = RentalManagerClient.create(config.chain);
  const healthMonitor = new HealthMonitorImpl(config, backend, undefined, undefined,
    async () => rentalClient.client.getChainId().then((id) => id === 46630));
  const dbPath = config.settlementDbPath ?? validateAndResolveSettlementDbPath(undefined);
  const journal = new SqliteSettlementJournal(dbPath, {
    busyTimeoutMs: config.settleBusyTimeoutMs,
  });
  return {
    config,
    logger: createLogger(config),
    rentalClient,
    backend,
    healthMonitor,
    inference: new InferenceClient(backend, config.limits),
    sessions: new SessionStoreImpl(),
    challenges: new ChallengeStore(config.limits.challengeTtlSeconds),
    quota: new RentalQuota(config.limits),
    journal,
    watcher: new ReservationWatcher(rentalClient, healthMonitor, config.watchIntervalMs, {
      autoStartEnabled: config.autoStartEnabled,
      autoSettlementEnabled: config.autoSettlementEnabled,
      maxSettleAttempts: config.settleRetryMaxAttempts,
      settleRetryDelayMs: config.settleRetryDelayMs,
      journal,
      claimLeaseMs: config.settleClaimLeaseMs,
    }),
  };
}

// ---------------------------------------------------------------------------
// Server factory (exported for testing).
//
// The argument is either the complete production dependency set or nothing at
// all. The default expression is evaluated lazily, so passing a ready-made
// `AgentDeps` — which every injected test does — never reaches `defaultDeps()`,
// `loadAgentConfig()` or `RentalManagerClient.create()`. That is what lets a
// fully faked server start with no env, no backend socket, no GPU and no chain
// connection. Calling `buildServer()` with no argument keeps the fail-fast
// production path: missing configuration or a missing RentalManager ABI throws
// here and still throws before the socket is opened.
//
// Partial dependency sets are deliberately not accepted. A half-injected server
// would silently mix real singletons with test doubles, so an incomplete object
// is a compile-time error rather than a runtime surprise.
// ---------------------------------------------------------------------------
export async function buildServer(deps: AgentDeps = defaultDeps()): Promise<FastifyInstance> {
  const { config, logger, rentalClient, backend, healthMonitor, inference, sessions, challenges, quota, watcher, journal } =
    deps;

  if (config.autoSettlementEnabled && journal) {
    if (!rentalClient.providerAddress) {
      throw new Error('DURABLE_CAPABILITY_MISSING: providerAddress capability missing on rentalClient');
    }
    if (typeof rentalClient.getTransactionCount !== 'function') {
      throw new Error('DURABLE_CAPABILITY_MISSING: getTransactionCount capability missing on rentalClient');
    }
    if (typeof rentalClient.submitTransaction !== 'function') {
      throw new Error('DURABLE_CAPABILITY_MISSING: submitTransaction capability missing on rentalClient');
    }
  }

  // The challenge domain pins every signature to this deployment: the chain id and
  // the RentalManager the rental lives on. Both call sites must agree, otherwise
  // recovery succeeds against a different separator than the browser signed.
  const challengeDomain = buildDomain(
    config.chain.chainId,
    config.chain.rentalManagerAddress as `0x${string}`,
  );

  // Fastify accepts a ready-made pino instance via `loggerInstance`, but its
  // type definition expects the instance to satisfy FastifyBaseLogger. We know
  // this is correct at runtime (proven by the integration tests), so we widen
  // the inferred type here.
  const app = Fastify({
    loggerInstance: logger,
    // Fastify 5 form of "do not log requests": the logger controller is what
    // emits the request line, and disabling it there is the supported option — the
    // top-level `disableRequestLogging` flag is deprecated (FSTDEP023) and removed
    // in Fastify 6. The redactors in `src/logger.ts` remain the second line of
    // defence for every other log line the app emits.
    logController: new LogController({ disableRequestLogging: true }),
    // 16 KiB ceiling on the parsed body. Fastify aborts the parse as soon as the
    // stream exceeds this, so a chunked request with no `content-length` header
    // is not subject to only stripping it — and the parse failure ends the route
    // before any handler body runs.
    bodyLimit: config.limits.maxJsonBodyBytes,
  }) as unknown as FastifyInstance;

  // CORS. An explicit allow-list only: never a wildcard and never reflecting
  // the request origin back, either of which would let any site drive this API
  // from a victim's browser.
  if (config.allowedOrigins.length > 0) {
    await app.register(cors, {
      origin: config.allowedOrigins,
      credentials: true,
    });
  }

  // -------------------------------------------------------------------------
  // Response headers, applied to every route including the ones registered
  // below. These are set per-request by a hook rather than on the Fastify
  // instance because the SSE reply in `POST /v1/inference` calls
  // `reply.raw.writeHead()` directly and would otherwise bypass them.
  //
  // `nosniff` is what stops a renter's browser from re-interpreting our JSON
  // error bodies as HTML, which is the precondition for any content-sniffing
  // XSS; `frame-ancestors 'none'` keeps the wallet prompt off a framed page;
  // `no-store` stops a proxy or the browser from retaining a body that carries
  // a bearer token or a challenge nonce; and the restrictive
  // `content-security-policy` covers the statically-served frontend, which
  // never needs scripts it does not ship itself.
  // -------------------------------------------------------------------------
  app.addHook('onSend', async (_request: any, reply: any, payload: any) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', `default-src 'self'; connect-src 'self' ${config.browserRpcOrigin ?? new URL(DEFAULT_RPC_URL).origin}; frame-ancestors 'none'; base-uri 'none'`);
    // All protocol errors go through the same catalogue, including errors caught
    // by individual routes. Never serialize dependency exception messages.
    if (reply.statusCode >= 400 && typeof payload === 'string') {
      try {
        const body = JSON.parse(payload);
        if (body && typeof body === 'object' && 'code' in body) {
          const safe = protocolError(body.code);
          reply.code(safe.status);
          return JSON.stringify(safe.body);
        }
      } catch { /* Not a JSON protocol response (e.g. a static stream). */ }
    }
    return payload;
  });

  // -------------------------------------------------------------------------
  // Only JSON is a request body. Fastify parses JSON out of the box but still
  // accepts `text/plain` (and form bodies) by default, which would hand a
  // handler a string it then has to defensively re-check. Rejecting the type at
  // the parser means `/auth/challenge`, `/auth/verify` and `/v1/inference` can
  // trust `request.body` is an object or absent.
  // -------------------------------------------------------------------------
  function unsupportedMediaType(): ArchcoreError {
    return new ArchcoreError(
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      'request body must be JSON',
      415,
    );
  }


  app.addContentTypeParser(
    'text/plain',
    { parseAs: 'string' },
    (_request: any, _payload: any, done: (error: Error | null) => void) => done(unsupportedMediaType()),
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request: any, _payload: any, done: (error: Error | null) => void) => done(unsupportedMediaType()),
  );

  // -------------------------------------------------------------------------
  // The default JSON parser is tightened to the same shape: an empty body is
  // legal (a GET, or a POST with nothing to send), but anything that is not an
  // object is INVALID_BODY (400), not an accepted handler payload.
  // -------------------------------------------------------------------------
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request: any, payload: any, done: (error: Error | null, body?: unknown) => void) => {
      const raw = payload?.toString?.() ?? '';
      if (raw.trim() === '') {
        done(null, {});
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        done(new ArchcoreError(ErrorCode.INVALID_BODY, 'request body must be valid JSON', 400));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        done(new ArchcoreError(ErrorCode.INVALID_BODY, 'request body must be a JSON object'));
        return;
      }
      done(null, parsed);
    },
  );

  // -------------------------------------------------------------------------
  // Parse failures become stable, safe 4xx/5xx bodies instead of Fastify's
  // default. An oversized or wrongly-typed body must not surface a parser or
  // framework error string, which can describe our internals, and must never
  // look like an authorization success.
  // -------------------------------------------------------------------------
  app.setErrorHandler(async (error: any, _request: any, reply: any) => {
    const tooLarge = error?.statusCode === 413;
    const wrongType = error?.statusCode === 415;
    const safe = protocolError(error instanceof ArchcoreError ? error.code
      : tooLarge ? ErrorCode.BODY_TOO_LARGE
      : wrongType ? ErrorCode.UNSUPPORTED_MEDIA_TYPE : ErrorCode.INTERNAL);
    reply.code(safe.status);
    return safe.body;
  });

  // -------------------------------------------------------------------------
  // GET /config
  //
  // The page needs the manager address to build its `rent()` call. Only the
  // approved public configuration is served: contract addresses, the frozen
  // chain/node ids, the EIP-712 audience and the inference mode. No rental
  // economics are served, because the Agent does not own them — a plan's price
  // and duration are read from the contract's frozen plan catalog through the
  // normalized Role 2 client, and the escrow is settled from what the contract
  // actually charged. No signer key, backend URL/model, credentialed RPC, or
  // tunnel credential is exposed.
  // -------------------------------------------------------------------------
  app.get('/config', async (_req: any, reply: any) => {
    reply.code(200);
    return {
      chainId: config.chain.chainId,
      nodeId: config.nodeId.toString(),
      computeAsset: config.chain.computeAssetAddress ?? '0x0000000000000000000000000000000000000000',
      rentalManager: config.chain.rentalManagerAddress,
      paymentToken: config.paymentToken ?? '0x7E955252E15c84f5768B83c41a71F9eba181802F',
      paymentSymbol: config.paymentSymbol ?? 'USDG',
      agentAudience: config.audience,
      interfaceVersion: config.interfaceVersion ?? '0.5',
      inferenceMode: config.inferenceMode ?? 'demo',
    };
  });

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------
  app.get('/health', async (_req: any, reply: any) => {
    const rawChecks = await healthMonitor.checks();
    const checks = rawChecks.map((c) => ({
      name: c.name,
      status: c.status,
    }));
    const requiredChecks = ['agent', 'rpc', 'backend'];
    const isDegraded = checks.some((c) => {
      if (requiredChecks.includes(c.name)) {
        return c.status !== 'ok';
      }
      return c.status === 'unhealthy';
    });
    const status = isDegraded ? 'degraded' : 'ok';
    reply.code(status === 'ok' ? 200 : 503);
    return {
      status,
      checks,
    };
  });

  // -------------------------------------------------------------------------
  // GET /node
  // -------------------------------------------------------------------------
  app.get('/node', async (_req: any, reply: any) => {
    try {
      const node = await rentalClient.getNode(config.nodeId);
      reply.code(200);
      return {
        nodeId: node.nodeId.toString(),
        provider: node.provider ?? '0x0000000000000000000000000000000000000000',
        name: /^0x0{64}$/i.test(node.name ?? '') ? '' : node.name ?? '',
        active: node.active ?? false,
      };
    } catch {
      reply.code(503);
      return { error: 'node lookup failed', code: 'RPC_UNAVAILABLE' };
    }
  });

  // -------------------------------------------------------------------------
  // GET /gpu/status
  // -------------------------------------------------------------------------
  app.get('/gpu/status', async (_req: any, reply: any) => {
    if (config.inferenceMode === 'demo') {
      reply.code(200);
      return {
        mode: 'demo',
        hardware: null,
        backend: 'demo-inference',
        ready: (await backend.checkReadiness()).ok,
      };
    }
    try {
      const { readGpu } = await import('./gpu.js');
      const gpu = await readGpu();
      reply.code(200);
      return gpu;
    } catch {
      reply.code(503);
      return { present: false, error: 'NODE_OFFLINE' };
    }
  });

  // -------------------------------------------------------------------------
  // POST /auth/challenge
  //
  // Mints a single-use nonce for the renter to sign. The rental must be ACTIVE
  // on this node right now: a RESERVED rental is not billable yet, so a session
  // minted against one would hand out compute before `startRental()` and
  // before anything was paid. The renter must also be an EOA — a contract can
  // only sign through a wallet, so `recoverTypedDataAddress` could never match
  // its address and the challenge would be unclaimable by anyone.
  // -------------------------------------------------------------------------
  app.post('/auth/challenge', async (request: any, reply: any) => {
    const rawBody = request.body;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      reply.code(400);
      return { error: 'request body must be a JSON object', code: 'INVALID_BODY' };
    }
    const extraKeys = Object.keys(rawBody).filter((k) => k !== 'rentalId');
    if (extraKeys.length > 0) {
      reply.code(400);
      return { error: `unknown request fields: ${extraKeys.join(', ')}`, code: 'INVALID_BODY' };
    }

    const body = rawBody as { rentalId?: string };
    const rentalId = body?.rentalId;
    if (typeof rentalId !== 'string' || !/^[1-9]\d*$/.test(rentalId) || BigInt(rentalId) >= 1n << 256n) {
      reply.code(400);
      return { error: 'rentalId must be a positive decimal integer', code: 'INVALID_BODY' };
    }

    const now = Math.floor(Date.now() / 1000);

    try {
      // One shared gate for the whole access path. It re-reads the rental from
      // the chain, fails closed on an RPC error, and rejects a rental that is
      // not ACTIVE on THIS node or that has already ended. Anything that gets
      // past here has been proven live seconds ago, from the chain.
      const rental = await loadAuthoritativeRental(rentalClient, BigInt(rentalId.trim()), config.nodeId);

      const isEoa = await rentalClient.isEoa(rental.renter).catch(() => {
        throw new ArchcoreError(ErrorCode.RPC_UNAVAILABLE, 'EOA chain read unavailable');
      });
      if (!isEoa) {
        // A contract renter cannot produce a signature that recovers to its own
        // address, so the challenge could never be claimed. Fail loudly here
        // instead of handing out a nonce that only leads to a dead end.
        reply.code(409);
        return { error: 'renter is a contract; only an EOA can unlock a rental', code: 'EOA_REQUIRED' };
      }

      const challengeExpiresAt = Math.min(now + config.limits.challengeTtlSeconds, Number(rental.expiresAt));
      if (challengeExpiresAt <= now) {
        reply.code(409);
        return { error: 'rental lease has ended', code: 'RENTAL_EXPIRED' };
      }

      const challenge = challenges.issue({
        rentalId: rental.rentalId.toString(),
        renter: rental.renter,
        nodeId: rental.nodeId.toString(),
        audience: config.audience,
        now,
        expiresAt: challengeExpiresAt,
      });

      const payload = typedDataPayload(challengeDomain, challenge);

      reply.code(201);
      // Public typed-data fields only. The store's `challenge` record carries the
      // internal `consumed` flag and is never serialised: a wallet forwards this
      // object into `eth_signTypedData_v4`, which rejects unknown keys.
      return {
        domain: payload.domain,
        // SIGN_TYPES (not payload.types) so the browser can forward this
        // object straight into `eth_signTypedData_v4`. Every integer stays a
        // string: that is exactly the JSON shape a wallet expects back.
        types: SIGN_TYPES,
        primaryType: payload.primaryType,
        message: {
          renter: challenge.renter,
          rentalId: challenge.rentalId,
          nodeId: challenge.nodeId,
          nonce: challenge.nonce,
          // EIP-712 integers serialise as decimal strings: that is the JSON shape
          // `eth_signTypedData_v4` expects, and it is also what the digest test
          // round-trips back with `Number(...)` before hashing. Sending raw
          // numbers makes a wallet silently coerce or reject the value.
          issuedAt: challenge.issuedAt.toString(),
          expiresAt: challenge.expiresAt.toString(),
          agentAudience: challenge.audience,
        },
      };
    } catch (error) {
      // The shared guard throws typed errors whose status code already says
      // what happened: 404 for an unknown rental, 409 for a rental that is not
      // usable by this caller, 503 for an RPC that is down. Collapsing them all
      // to one status would tell the browser to retry a denial. The message is
      // never the raw error, which can carry endpoint URLs and provider payloads.
      const safe = protocolError(error instanceof ArchcoreError ? error.code : ErrorCode.INTERNAL);
      const { status: statusCode } = safe;
      const code = safe.body.code;
      logger.warn({ rentalId, code, success: false }, 'challenge denied');
      reply.code(statusCode);
      return safe.body;
    }
  });

  // -------------------------------------------------------------------------
  // POST /auth/verify
  //
  // The renter proves it controls the on-chain renter address of an ACTIVE
  // rental. The recovered signer is the only authority; the request schema is
  // exactly signature, nonce, and rentalId. The rental is re-read from the
  // chain rather than trusted from the caller or from the challenge record.
  // -------------------------------------------------------------------------
  app.post('/auth/verify', async (request: any, reply: any) => {
    const rawBody = request.body;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      reply.code(400);
      return { error: 'request body must be a JSON object', code: 'INVALID_BODY' };
    }

    const allowedVerifyKeys = new Set(['signature', 'nonce', 'rentalId']);
    const extraKeys = Object.keys(rawBody).filter((k) => !allowedVerifyKeys.has(k));
    if (extraKeys.length > 0) {
      reply.code(400);
      return { error: `unknown request fields: ${extraKeys.join(', ')}`, code: 'INVALID_BODY' };
    }

    const body = rawBody as { signature?: string; nonce?: string; rentalId?: string };

    if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(body.signature)
      || typeof body.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.nonce)
      || typeof body.rentalId !== 'string') {
      reply.code(400);
      return { error: 'signature, nonce and rentalId are required', code: 'INVALID_BODY' };
    }
    if (!/^[1-9]\d*$/.test(body.rentalId) || BigInt(body.rentalId) >= 1n << 256n) {
      reply.code(400);
      return { error: 'rentalId must be a positive decimal integer', code: 'INVALID_BODY' };
    }

    const now = Math.floor(Date.now() / 1000);
    const rentalId = BigInt(body.rentalId.trim());

    try {
      // Lookup first, consume only after the signature vouches for the renter, so
      // a bad or mismatched signature never burns a still-valid challenge.
      const challenge = challenges.lookup(body.nonce, body.rentalId.trim(), now, config.audience);

      // The rental is re-read from the chain through the same shared gate the
      // challenge route uses, rather than trusted from the caller or from the
      // challenge record. A reachable-but-failing RPC is a dependency outage,
      // not a caller mistake, so the guard reports 503 and the browser retries.
      // The message stays generic: RPC error strings can carry endpoint URLs and
      // provider payloads.
      const rental = await loadAuthoritativeRental(rentalClient, rentalId, config.nodeId);

      const recovered = await verifyChallenge({
        challenge,
        signature: body.signature,
        domain: challengeDomain,
        rental,
        now,
        audience: config.audience,
      });

      // RPC reads and signature recovery are asynchronous. Revalidate time at
      // issuance, not just the timestamp captured before those awaits.
      const issuanceNow = Math.floor(Date.now() / 1000);
      challenges.lookup(body.nonce, body.rentalId, issuanceNow, config.audience);
      assertRentalIsActiveForNode(rental, config.nodeId, issuanceNow, recovered);

      // Consume only now that the signature has been recovered and matched.
      // `consume` never throws: `false` means another caller won the race on the
      // same nonce, or the TTL lapsed between the lookup above and here. Either
      // way the challenge is burned and no session may be minted.
      const consumed = challenges.consume(body.nonce, body.rentalId, issuanceNow, config.audience);
      if (!consumed) {
        reply.code(409);
        return { error: 'challenge already used', code: 'CHALLENGE_REPLAYED' };
      }

      const { token, session } = sessions.create({
        rentalId: rental.rentalId.toString(),
        nodeId: config.nodeId.toString(),
        renter: recovered,
        expiresAt: Number(rental.expiresAt),
      });

      logger.info(
        {
          rentalId: session.rentalId,
          nodeId: session.nodeId,
          success: true,
        },
        'session created',
      );

      // The raw token is written to this HTTPS body exactly once and is never
      // logged, never echoed by any other route, and never stored - only its
      // digest lives on the server. It travels afterwards as
      // `Authorization: Bearer <token>`, never as a path, query or cookie.
      reply.code(201);
      return {
        token,
        rentalId: session.rentalId,
        expiresAt: session.expiresAt.toString(),
      };
    } catch (error) {
      const safe = protocolError(error instanceof ArchcoreError || error instanceof AuthError
        ? error.code : ErrorCode.INTERNAL);
      const code = safe.body.code;
      logger.warn(
        {
          rentalId: body?.rentalId,
          code,
          success: false,
        },
        'verification failed',
      );
      reply.code(safe.status);
      return safe.body;
    }
  });

  // -------------------------------------------------------------------------
  // POST /v1/inference
  //
  // Requires a bearer session whose rental is still ACTIVE on-chain, and
  // honours the P0 ceilings. The model, the prompt bounds and the generation
  // budget are the node's own configuration and are never taken from the
  // request: a caller-supplied model or base URL would let a renter point the
  // provider's GPU at their own service.
  // -------------------------------------------------------------------------
  app.post('/v1/inference', async (request: any, reply: any) => {
    // Session gate — the authorization header carries the bearer token.
    const authHeader = request.headers?.authorization;
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : '';
    if (token.length === 0) {
      reply.code(401);
      return { error: 'invalid session', code: 'INVALID_SESSION' };
    }

    const now = Math.floor(Date.now() / 1000);

    // Sessions are minted only after a valid signature over an ACTIVE rental,
    // so the bearer token is the capability that authorizes inference.
    let session: { rentalId: string; renter: string; expiresAt: number };
    try {
      session = sessions.get(token, now);
    } catch (err) {
      if (err instanceof ArchcoreError && err.code === 'SESSION_EXPIRED') {
        reply.code(409);
        return { error: 'rental lease has ended', code: 'SESSION_EXPIRED' };
      }
      reply.code(401);
      return { error: 'invalid session', code: 'INVALID_SESSION' };
    }

    // The lease must still be ACTIVE on-chain, on this node, and held by the
    // same renter the session was minted for. This is the same shared gate the
    // challenge and verify routes use, so an RPC outage is a 503 here and not an
    // unhandled 500, and a rental that ended on-chain ends access even when the
    // stored session expiry has not been reached.
    //
    // The renter check is separate: the session's own digest stays valid after a
    // lease moves to somebody else, so only comparing it to the live chain state
    // would let the previous renter keep using the GPU.
    let rental: ChainRental;
    try {
      rental = await loadAuthoritativeRental(rentalClient, BigInt(session.rentalId), config.nodeId);
    } catch (error) {
      const safe = protocolError(error instanceof ArchcoreError ? error.code : ErrorCode.INTERNAL);
      reply.code(safe.status);
      return safe.body;
    }
    if (rental.renter.toLowerCase() !== session.renter.toLowerCase()) {
      reply.code(409);
      return { error: 'session renter no longer holds this rental', code: 'SESSION_RENTER_MISMATCH' };
    }

    const body = (request.body ?? {}) as Record<string, unknown>;

    // Reject additional model/backend/options fields and unknown keys.
    const extraKeys = Object.keys(body).filter((k) => k !== 'prompt');
    if (extraKeys.length > 0) {
      reply.code(400);
      return { error: `"${extraKeys[0]}" is not accepted by this endpoint`, code: 'INVALID_BODY' };
    }

    const prompt = body.prompt;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      reply.code(400);
      return { error: 'prompt is required', code: 'INVALID_BODY' };
    }
    if (Buffer.byteLength(prompt, 'utf8') > config.limits.maxPromptBytes) {
      reply.code(413);
      return {
        error: 'prompt too large',
        code: 'BODY_TOO_LARGE',
        limit: config.limits.maxPromptBytes,
      };
    }

    // Counters are keyed by rentalId, so one rental cannot spend another
    // rental's budget, and the single GPU slot is claimed for the whole P0
    // concurrency ceiling of one.
    const rentalId = BigInt(session.rentalId);
    try {
      quota.acquire(rentalId, Date.now());
    } catch (error) {
      const safe = protocolError(error instanceof ArchcoreError ? error.code : ErrorCode.INTERNAL);
      reply.code(safe.status);
      return safe.body;
    }

    // One controller covers every reason to stop the GPU: the remaining lease,
    // the operator's generation ceiling, and the client going away. Aborting it
    // aborts the backend request itself, not only the HTTP response.
    const controller = new AbortController();
    const remainingMs = Math.max(0, Math.min(session.expiresAt, Number(rental.expiresAt)) * 1000 - Date.now());
    const generationCapMs = config.limits.maxGenerationSeconds * 1000;
    const expiryTimer = setTimeout(
      () => controller.abort(new Error(remainingMs <= generationCapMs ? 'lease expired' : 'generation timeout')),
      Math.min(remainingMs, generationCapMs),
    );
    expiryTimer.unref?.();

    // The incoming message's `close` fires as soon as the request body has been
    // read, which is before generation starts, so it cannot be the disconnect
    // signal. The reply socket's `close` fires when the client drops the
    // connection; `writableEnded` distinguishes that from our own response
    // finishing, which must not abort a generation that already completed.
    const onClientGone = (): void => {
      if (!reply.raw.writableEnded) controller.abort(new Error('client disconnected'));
    };
    reply.raw.once('close', onClientGone);

    // The streaming reply mirrors what the frontend's SSE parser expects, so a
    // token emitted at expiry is visible as a `delta` event and the termination is
    // visible as an explicit `error` event — never as a socket that just stops.
    reply.hijack();
    const requestOrigin = typeof request.headers?.origin === 'string'
      ? request.headers.origin
      : undefined;
    const allowedStreamOrigin = requestOrigin !== undefined
      && config.allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : undefined;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      // `reply.hijack()` bypasses Fastify's normal response lifecycle. The
      // browser has already passed the CORS preflight, but it must also see the
      // allow-origin header on the actual SSE response or fetch reports only a
      // network-level `TypeError: Failed to fetch`. Keep the exact configured
      // allow-list semantics: never use a wildcard and never reflect an
      // untrusted origin.
      ...(allowedStreamOrigin === undefined
        ? {}
        : {
            'access-control-allow-origin': allowedStreamOrigin,
            vary: 'Origin',
          }),
    });

    const send = (event: string, payload: unknown): void => {
      if (reply.raw.writableEnded) return;
      if (event === 'error') {
        const safe = protocolError((payload as { code?: string }).code).body;
        payload = { code: safe.code, error: safe.error };
      }
      // Output only ever travels on this single stream, which is followed by a
      // flush on every chunk because the whole point is incremental delivery.
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const result = await inference.generateStream(
        {
          model: backend.model,
          prompt,
          // The node operator owns the token ceiling: a renter cannot raise it
          // to monopolise the GPU for the rest of the window.
          options: { num_predict: config.limits.maxOutputTokens },
        },
        controller.signal,
        {
          // Each delta is forwarded as it is produced, so the 30-second / lease
          // watchdog stops tokens flowing mid-answer instead of after the whole
          // generation has been buffered out of reach.
          onDelta: (delta) => send('delta', { output: delta }),
        },
      );
      if (controller.signal.aborted || Date.now() >= Math.min(session.expiresAt, Number(rental.expiresAt)) * 1000) {
        throw new InferenceError('generation stopped', 'ABORTED_AT_EXPIRY');
      }
      send('complete', {
        output: result.output,
        // Echo the node's own model, never anything derived from the request.
        model: result.model,
        latencyMs: result.latencyMs,
      });
      logger.info(
        {
          rentalId: session.rentalId,
          model: result.model,
          latencyMs: result.latencyMs,
          success: true,
        },
        'inference completed',
      );
      reply.raw.end();
      return reply;
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof Error && reason.message === 'client disconnected') {
          // The client is already gone; the status is for the log, not a body
          // anyone will read. The slot is released in `finally`, and the socket is
          // closed here so a half-read stream cannot be mistaken for a live one.
          logger.warn(
            {
              rentalId: session.rentalId,
              code: 'CLIENT_DISCONNECTED',
              success: false,
            },
            'client disconnected',
          );
          reply.raw.end();
          return reply;
        }
        // The stream is closed on this path, not merely status-coded: the
        // connected socket is what the watchdog actually terminates.
        const abortCode = reason instanceof Error && reason.message === 'generation timeout'
          ? 'INFERENCE_FAILED' : 'ABORTED_AT_EXPIRY';
        logger.warn(
          {
            rentalId: session.rentalId,
            code: abortCode,
            success: false,
          },
          'generation stopped',
        );
        send('error', { code: abortCode, error: protocolError(abortCode).body.error });
        reply.raw.end();
        return reply;
      }
      const code = error instanceof InferenceError ? error.code : 'INFERENCE_FAILED';
      logger.warn(
        {
          rentalId: session.rentalId,
          code,
          success: false,
        },
        'inference failed',
      );
      send('error', { code, error: 'inference failed' });
      reply.raw.end();
      return reply;
    } finally {
      // Always release, including on abort and client disconnect, otherwise one
      // crashed generation wedges the node for the rest of the rental.
      clearTimeout(expiryTimer);
      reply.raw.removeListener('close', onClientGone);
      quota.release(rentalId);
    }
  });

  // -------------------------------------------------------------------------
  // Renter frontend
  // -------------------------------------------------------------------------
  await serveStatic(app, { root: DEFAULT_WEB_ROOT });

  // Graceful shutdown hook: stop watcher and close SQLite journal if open
  app.addHook('onClose', async () => {
    watcher.stop();
    if (journal) {
      journal.close();
    }
  });

  return app;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const deps = defaultDeps();
  const { config, logger, watcher } = deps;
  const app = await buildServer(deps);
  const address = `${config.host}:${config.port}`;
  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info({ address }, 'ARCHcore Provider Agent listening');
    logger.info(
      {
        autoStart: config.autoStartEnabled,
        autoSettle: config.autoSettlementEnabled,
        watchIntervalMs: config.watchIntervalMs,
      },
      'reservation watcher starting',
    );

    const shutdown = async () => {
      try {
        await app.close();
      } catch (err) {
        logger.error(toSafeError(err), 'error during graceful shutdown');
      }
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });

    // Start the reservation watcher in the background. The agent
    // owns automatic startRental() and automatic settleAfterExpiry().
    // Also run when a journal exists for read-only recovery at startup.
    if (config.autoStartEnabled || config.autoSettlementEnabled || config.settlementDbPath) {
      watcher.run().catch((error) => {
        logger.error(toSafeError(error), 'reservation watcher terminated unexpectedly');
      });
    }
  } catch (error) {
    logger.error(toSafeError(error), 'agent failed to start');
    process.exitCode = 1;
  }
}

// Only run when this file is the actual entry point, not when it is imported
// for its exports (which is how every unit/integration test loads it). The
// canonical Node guard is `require.main === module`, but that meta-object is
// not reliably injected when ESM loaders like `tsx` transpile this file, so we
// compare absolute paths instead: when `src/server.ts` is the script passed to
// node, `process.argv[1]` normalises to the same absolute path as `__filename`;
// when a test runner or another script imports it, the entry is different.
declare const require: {
  main: { filename: string } | undefined;
};
if (require.main?.filename !== undefined) {
  const entry = require.main.filename.toLowerCase();
  const me = __filename.toLowerCase();
  if (entry === me) {
    void main().catch((error: unknown) => {
      console.error(toSafeError(error));
      process.exitCode = 1;
    });
  }
}
