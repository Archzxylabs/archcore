import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GpuSample {
  present: boolean;
  name?: string;
  memoryTotalMb?: number;
  memoryUsedMb?: number;
  memoryFreeMb?: number;
  utilizationPercent?: number;
  temperatureC?: number;
  powerDrawW?: number;
  /** `NODE_UNSUPPORTED_GPU` when nvidia-smi is unavailable. */
  error?: string;
}

const QUERY =
  'name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw';

const GPU_ARGS = [
  `--query-gpu=${QUERY}`,
  '--format=csv,noheader,nounits',
];

/** Default answer: no GPU in this environment reports a not-present sample. */
const UNSUPPORTED_GPU: GpuSample = { present: false, error: 'NODE_UNSUPPORTED_GPU' };

/**
 * Runs `nvidia-smi` and parses its row.
 *
 * `command` exists so a test can supply an answer without a GPU or an
 * `nvidia-smi` binary on the machine that runs the suite: patching
 * `execFile` at runtime cannot work, because `promisify(execFile)` is bound
 * once at module load. The default runs the real command.
 */
export async function readGpu(
  timeoutMs = 4000,
  command: (args: string[], timeoutMs: number) => Promise<{ stdout: string }> = (
    args,
    timeout,
  ) => execFileAsync('nvidia-smi', args, { timeout, maxBuffer: 64 * 1024 }),
): Promise<GpuSample> {
  try {
    const { stdout } = await command(GPU_ARGS, timeoutMs);
    const [name, total, used, util, temp, power] = stdout
      .trim()
      .split('\n')[0]!
      .split(',')
      .map((part) => part.trim());

    const memoryTotalMb = Number(total);
    const memoryUsedMb = Number(used);
    const memoryFreeMb =
      Number.isFinite(memoryTotalMb) && Number.isFinite(memoryUsedMb)
        ? memoryTotalMb - memoryUsedMb
        : undefined;

    // A row without a name or without numeric memory is not a GPU this node can
    // serve on: reporting `present: true` here would make a wedged or empty
    // `nvidia-smi` look like a usable GPU, and the health check would then
    // report `ok` while the numbers it advertises are NaN.
    if (!name || !Number.isFinite(memoryTotalMb)) {
      return UNSUPPORTED_GPU;
    }

    return {
      present: true,
      name,
      memoryTotalMb,
      memoryUsedMb,
      memoryFreeMb,
      utilizationPercent: Number(util),
      temperatureC: Number(temp),
      powerDrawW: power === undefined || power === '' || power === '[N/A]' ? undefined : Number(power),
    };
  } catch {
    // nvidia-smi missing, no NVIDIA driver, or no GPU: the node cannot serve
    // the demo and the agent reports it rather than falling back silently.
    return UNSUPPORTED_GPU;
  }
}

/** How long a GPU sample stays fresh, in ms. */
export const GPU_SAMPLE_TTL_MS = 5_000;

interface GpuCacheEntry {
  sample: GpuSample;
  readAtMs: number;
}

let cache: GpuCacheEntry | undefined;
let inFlight: Promise<GpuSample> | undefined;

/** Test/diagnostics hook: drops the cached sample and any in-flight read. */
export function resetGpuCache(): void {
  cache = undefined;
  inFlight = undefined;
}

/**
 * Cached, bounded GPU sample for the health and auto-start paths.
 *
 * `/health` and the reservation watcher both probe the GPU, and `nvidia-smi`
 * can be slow enough that a fresh child process per hit would spend the whole
 * health window waiting on it. A sample is reused for `ttlMs`, and concurrent
 * callers during a slow command share the single in-flight read instead of each
 * spawning their own process — this is what makes a bounded probe also cheap.
 *
 * The read is always bounded by its own `timeoutMs`, and any rejection resolves
 * to a `present: false` sample rather than throwing: a GPU probe must never
 * crash the server or leave a caller's promise pending.
 */
export function readGpuCached(
  timeoutMs = 4000,
  ttlMs = GPU_SAMPLE_TTL_MS,
  now = Date.now(),
  command?: (args: string[], timeoutMs: number) => Promise<{ stdout: string }>,
): Promise<GpuSample> {
  if (cache && now - cache.readAtMs < ttlMs) {
    return Promise.resolve(cache.sample);
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = readGpu(timeoutMs, command)
    .catch(() => UNSUPPORTED_GPU)
    .then((sample) => {
      cache = { sample, readAtMs: now };
      inFlight = undefined;
      return sample;
    });
  return inFlight;
}
