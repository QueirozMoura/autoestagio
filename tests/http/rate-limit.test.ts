import { describe, expect, it } from 'vitest';
import { HostRateLimiter, systemClock } from '../../src/http/rate-limit.js';
import { FakeClock } from '../helpers/mock-fetch.js';

describe('HostRateLimiter', () => {
  it('não espera na primeira requisição', async () => {
    const clock = new FakeClock();
    const limiter = new HostRateLimiter({ defaultIntervalMs: 2000, clock });
    (await limiter.acquire('a.com'))();
    expect(clock.sleeps).toEqual([]);
  });

  it('espera o intervalo mínimo entre requisições ao mesmo host', async () => {
    const clock = new FakeClock();
    const limiter = new HostRateLimiter({ defaultIntervalMs: 2000, clock });
    (await limiter.acquire('a.com'))();
    (await limiter.acquire('a.com'))();
    expect(clock.sleeps).toEqual([2000]);
  });

  it('hosts diferentes não se atrapalham', async () => {
    const clock = new FakeClock();
    const limiter = new HostRateLimiter({ defaultIntervalMs: 2000, clock });
    (await limiter.acquire('a.com'))();
    (await limiter.acquire('b.com'))();
    expect(clock.sleeps).toEqual([]);
  });

  it('serializa requisições concorrentes ao mesmo host', async () => {
    const limiter = new HostRateLimiter({ defaultIntervalMs: 0, clock: new FakeClock() });
    const events: string[] = [];

    const run = async (name: string): Promise<void> => {
      const release = await limiter.acquire('a.com');
      events.push(`inicio ${name}`);
      await Promise.resolve();
      await Promise.resolve();
      events.push(`fim ${name}`);
      release();
    };
    await Promise.all([run('1'), run('2'), run('3')]);

    expect(events).toEqual(['inicio 1', 'fim 1', 'inicio 2', 'fim 2', 'inicio 3', 'fim 3']);
  });

  it('usa o intervalo específico do host', async () => {
    const clock = new FakeClock();
    const limiter = new HostRateLimiter({
      defaultIntervalMs: 2000,
      perHostIntervalMs: { 'lento.com': 5000 },
      clock,
    });
    (await limiter.acquire('lento.com'))();
    (await limiter.acquire('lento.com'))();
    expect(clock.sleeps).toEqual([5000]);
  });

  it('delayHost adia a próxima requisição', async () => {
    const clock = new FakeClock();
    const limiter = new HostRateLimiter({ defaultIntervalMs: 0, clock });
    limiter.delayHost('a.com', 7000);
    (await limiter.acquire('a.com'))();
    expect(clock.sleeps).toEqual([7000]);
  });

  it('raiseInterval aumenta, mas nunca reduz o intervalo', async () => {
    const clock = new FakeClock();
    const limiter = new HostRateLimiter({ defaultIntervalMs: 2000, clock });
    limiter.raiseInterval('a.com', 10_000);
    limiter.raiseInterval('a.com', 100);
    (await limiter.acquire('a.com'))();
    (await limiter.acquire('a.com'))();
    expect(clock.sleeps).toEqual([10_000]);
  });

  it('liberar duas vezes é inofensivo', async () => {
    const limiter = new HostRateLimiter({ defaultIntervalMs: 0, clock: new FakeClock() });
    const release = await limiter.acquire('a.com');
    release();
    release();
    (await limiter.acquire('a.com'))();
  });

  it('cancelar a espera libera a fila', async () => {
    const limiter = new HostRateLimiter({ defaultIntervalMs: 60_000, clock: systemClock });
    (await limiter.acquire('a.com'))();

    const controller = new AbortController();
    const waiting = limiter.acquire('a.com', controller.signal);
    controller.abort(new Error('cancelado'));
    await expect(waiting).rejects.toThrow('cancelado');

    // A fila não trava: a espera cancelada foi liberada e a seguinte também pode ser cancelada.
    const other = new AbortController();
    const next = limiter.acquire('a.com', other.signal);
    other.abort(new Error('cancelado 2'));
    await expect(next).rejects.toThrow('cancelado 2');
  });
});
