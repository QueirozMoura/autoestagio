import { describe, expect, it } from 'vitest';
import { RETRYABLE_STATUS, backoffDelay, parseRetryAfter } from '../../src/http/retry.js';

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('interpreta segundos', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
  });

  it('interpreta data HTTP', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
  });

  it('data no passado vira 0', () => {
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0);
  });

  it('ignora ausente ou inválido', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('em breve', now)).toBeUndefined();
  });
});

describe('backoffDelay', () => {
  const base = { baseMs: 1000, maxMs: 10_000 };

  it('cresce exponencialmente, entre metade e o valor cheio', () => {
    expect(backoffDelay(0, { ...base, random: () => 0 })).toBe(500);
    expect(backoffDelay(0, { ...base, random: () => 1 })).toBe(1000);
    expect(backoffDelay(2, { ...base, random: () => 1 })).toBe(4000);
  });

  it('respeita o teto', () => {
    expect(backoffDelay(10, { ...base, random: () => 1 })).toBe(10_000);
  });
});

describe('RETRYABLE_STATUS', () => {
  it('repete 429 e 5xx transitórios, mas não 403/404', () => {
    expect([429, 500, 502, 503, 504].every((s) => RETRYABLE_STATUS.has(s))).toBe(true);
    expect(RETRYABLE_STATUS.has(403)).toBe(false);
    expect(RETRYABLE_STATUS.has(404)).toBe(false);
  });
});
