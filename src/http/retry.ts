/** Status HTTP que justificam nova tentativa. 401/403/404 e demais 4xx nunca são repetidos. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Interpreta `Retry-After` (segundos ou data HTTP) e devolve a espera em ms. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  random: () => number;
}

/** Backoff exponencial com "equal jitter": metade fixa e metade aleatória. */
export function backoffDelay(attempt: number, { baseMs, maxMs, random }: BackoffOptions): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exponential / 2 + (random() * exponential) / 2);
}
