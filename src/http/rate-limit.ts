export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error('Operação cancelada');
}

interface HostState {
  /** Fila: cada requisição espera a anterior ao mesmo host terminar. */
  tail: Promise<void>;
  nextAllowedAt: number;
  intervalMs: number;
}

export interface HostRateLimiterOptions {
  /** Intervalo mínimo entre o fim de uma requisição e o início da próxima ao mesmo host. */
  defaultIntervalMs: number;
  perHostIntervalMs?: Record<string, number>;
  clock?: Clock;
}

/**
 * Limita o ritmo por host: uma requisição por vez e um intervalo mínimo entre elas.
 * Hosts diferentes não se atrapalham.
 */
export class HostRateLimiter {
  private readonly hosts = new Map<string, HostState>();
  private readonly clock: Clock;
  private readonly defaultIntervalMs: number;
  private readonly perHostIntervalMs: Record<string, number>;

  constructor(options: HostRateLimiterOptions) {
    this.clock = options.clock ?? systemClock;
    this.defaultIntervalMs = options.defaultIntervalMs;
    this.perHostIntervalMs = options.perHostIntervalMs ?? {};
  }

  /** Aguarda a vez do host. O `release` devolvido deve ser chamado ao fim da requisição. */
  async acquire(host: string, signal?: AbortSignal): Promise<() => void> {
    const state = this.stateFor(host);
    const previous = state.tail;
    let unlock: () => void = () => undefined;
    state.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });

    try {
      await previous;
      signal?.throwIfAborted();
      for (let wait = state.nextAllowedAt - this.clock.now(); wait > 0;) {
        await this.clock.sleep(wait, signal);
        wait = state.nextAllowedAt - this.clock.now();
      }
    } catch (error) {
      unlock();
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.nextAllowedAt = Math.max(state.nextAllowedAt, this.clock.now() + state.intervalMs);
      unlock();
    };
  }

  /** Adia novas requisições ao host (por exemplo, após `Retry-After` ou antes de um retry). */
  delayHost(host: string, ms: number): void {
    const state = this.stateFor(host);
    state.nextAllowedAt = Math.max(state.nextAllowedAt, this.clock.now() + ms);
  }

  /** Aumenta (nunca reduz) o intervalo do host, por exemplo por causa de `Crawl-delay`. */
  raiseInterval(host: string, ms: number): void {
    const state = this.stateFor(host);
    state.intervalMs = Math.max(state.intervalMs, ms);
  }

  private stateFor(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = {
        tail: Promise.resolve(),
        nextAllowedAt: 0,
        intervalMs: this.perHostIntervalMs[host] ?? this.defaultIntervalMs,
      };
      this.hosts.set(host, state);
    }
    return state;
  }
}
