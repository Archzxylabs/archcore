import { ArchcoreError, ErrorCode } from '@archcore/shared';
import { GPU_SAMPLE_TTL_MS, readGpuCached, type GpuSample } from './gpu.js';
import type { AgentConfig, HealthCheck } from './config.js';
import type { InferenceBackendAdapter } from './adapter.js';

/**
 * Liveness and readiness signals for `/health`.
 *
 * In accordance with PRD v0.5 and the interface ledger:
 * - Distinguishes Agent, RPC, backend/tunnel, and actual GPU readiness.
 * - Demo mode leaves GPU unknown and never calls nvidia-smi. Hardware detection
 *   remains a future real-hardware diagnostic, not a P0 readiness requirement.
 * - Reports `ok` when the dependency is fully operational, `degraded` when operational
 *   but constrained (e.g. GPU hot or low VRAM), and `unhealthy` when not usable.
 */
export class HealthMonitor {
  constructor(
    readonly config: AgentConfig,
    private readonly backend: InferenceBackendAdapter,
    private readonly gpuReader: () => Promise<GpuSample> = defaultGpuReader,
    /**
     * Runs the GPU command. Only reached when `gpuReader` is the default.
     */
    private readonly runCommand?: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>,
    /**
     * Optional custom RPC probe callback.
     */
    private readonly rpcProber?: () => Promise<boolean>,
  ) {
    this.cachedRental = undefined;
  }

  /** Most recently seen on-chain rental. */
  cachedRental?: { rentalId: bigint; nodeId: bigint; expiresAt: number; startDeadline: number };

  get nodeId(): bigint {
    return this.config.chain.nodeId;
  }

  async checks(): Promise<HealthCheck[]> {
    return Promise.all([
      this.checkAgent(),
      this.checkRpc(),
      this.checkPrivateRoute(),
      this.checkBackend(),
      this.checkGpu(),
    ]);
  }

  private async checkAgent(): Promise<HealthCheck> {
    return {
      name: 'agent',
      status: 'ok',
      detail: `Agent online and bound to loopback (${this.config.host}:${this.config.port})`,
    };
  }

  private async checkRpc(): Promise<HealthCheck> {
    if (this.rpcProber) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const ok = await Promise.race([
          this.rpcProber(),
          new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 3000); }),
        ]);
        return {
          name: 'rpc',
          status: ok ? 'ok' : 'unhealthy',
          detail: ok ? 'RPC responsive' : 'RPC probe failed',
        };
      } catch {
        return {
          name: 'rpc',
          status: 'unhealthy',
          detail: 'RPC connection failed',
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    const rpcUrl = this.config.chain.rpcUrl;
    if (!rpcUrl || rpcUrl.trim().length === 0) {
      return {
        name: 'rpc',
        status: 'unhealthy',
        detail: 'RPC URL missing',
      };
    }
    // Configuration is not a successful probe. Runtime supplies a bounded
    // chain-ID probe; test monitors can explicitly inject their own probe.
    return { name: 'rpc', status: 'unknown', detail: 'RPC has not been probed' };
  }

  private async checkPrivateRoute(): Promise<HealthCheck> {
    return {
      name: 'privateRoute',
      status: 'unknown',
      detail: 'Private OmniRoute not verified from agent loopback',
    };
  }

  private async checkBackend(): Promise<HealthCheck> {
    try {
      const readiness = await this.backend.checkReadiness();
      return {
        name: 'backend',
        status: readiness.ok ? 'ok' : 'unhealthy',
        detail: readiness.detail,
      };
    } catch {
      return {
        name: 'backend',
        status: 'unhealthy',
        detail: 'Backend check failed',
      };
    }
  }

  private async checkGpu(): Promise<HealthCheck> {
    if (this.config.inferenceMode === 'demo') {
      return { name: 'gpu', status: 'unknown', detail: 'No physical GPU is used in demo mode' };
    }
    try {
      const gpu = await this.readGpuBounded();
      if (!gpu.present) {
        if (this.config.inferenceMode === 'demo') {
          return { name: 'gpu', status: 'unknown', detail: 'GPU optional in demo mode' };
        }
        return { name: 'gpu', status: 'unhealthy', detail: gpu.error ?? 'NODE_UNSUPPORTED_GPU' };
      }
      if (gpu.temperatureC !== undefined && gpu.temperatureC >= this.config.gpu.maxTemperatureC) {
        return {
          name: 'gpu',
          status: 'degraded',
          detail: `GPU ${gpu.temperatureC}C >= ${this.config.gpu.maxTemperatureC}C`,
        };
      }
      if (gpu.memoryFreeMb !== undefined && gpu.memoryFreeMb < this.config.gpu.minFreeVramMb) {
        return {
          name: 'gpu',
          status: 'degraded',
          detail: `free VRAM ${gpu.memoryFreeMb}MB < ${this.config.gpu.minFreeVramMb}MB`,
        };
      }
      return { name: 'gpu', status: 'ok', detail: gpu.name ?? 'gpu present' };
    } catch (e) {
      if (this.config.inferenceMode === 'demo') {
        return { name: 'gpu', status: 'unknown', detail: 'GPU optional in demo mode' };
      }
      return { name: 'gpu', status: 'unhealthy', detail: e instanceof Error ? e.message : 'GPU read failed' };
    }
  }

  /**
   * Fresh sample from the GPU reader.
   */
  readGpu(): Promise<GpuSample> {
    if (this.gpuReader !== defaultGpuReader) {
      return this.gpuReader();
    }
    return readGpuCached(undefined, GPU_SAMPLE_TTL_MS, undefined, this.runCommand);
  }

  private readGpuBounded(): Promise<GpuSample> {
    return this.readGpu();
  }

  /** True only when required checks are ok. */
  async isReady(): Promise<boolean> {
    const checks = await this.checks();
    const required = this.config.inferenceMode === 'demo' ? ['agent', 'rpc', 'backend'] : ['agent', 'rpc', 'backend', 'gpu'];
    return checks
      .filter((check) => required.includes(check.name))
      .every((check) => check.status === 'ok');
  }

  /** Refresh the cached rental after a watcher tick. */
  updateCachedRental(rental: {
    rentalId: bigint;
    nodeId: bigint;
    expiresAt: number;
    startDeadline: number;
  }): void {
    this.cachedRental = rental;
  }

  /** Callback after startRental() succeeded on-chain. */
  onRentalStarted(_rentalId: bigint, _receipt: `0x${string}`): void {}
}

async function defaultGpuReader() {
  const { readGpu } = await import('./gpu.js');
  return readGpu();
}

/** GPU gate for the automatic startRental(). */
export function gpuAllowsStart(gpu: GpuSample, config: AgentConfig): ArchcoreError | null {
  if (!gpu.present) {
    return new ArchcoreError(ErrorCode.GPU_UNAVAILABLE, 'NODE_UNSUPPORTED_GPU', 503);
  }
  if (gpu.temperatureC !== undefined && gpu.temperatureC >= config.gpu.maxTemperatureC) {
    return new ArchcoreError(
      ErrorCode.GPU_TOO_HOT,
      `GPU ${gpu.temperatureC}C >= ${config.gpu.maxTemperatureC}C`,
      503,
    );
  }
  if (gpu.memoryFreeMb !== undefined && gpu.memoryFreeMb < config.gpu.minFreeVramMb) {
    return new ArchcoreError(
      ErrorCode.GPU_UNAVAILABLE,
      `free VRAM ${gpu.memoryFreeMb}MB < ${config.gpu.minFreeVramMb}MB`,
      503,
    );
  }
  return null;
}
