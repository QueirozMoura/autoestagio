import { describe, expect, it, vi } from 'vitest';
import { RobotsChecker, parseRobots, productToken } from '../../src/http/robots.js';

describe('productToken', () => {
  it('extrai o token do User-Agent', () => {
    expect(productToken('AutoEstagio/0.1 (uso pessoal)')).toBe('autoestagio');
  });
});

describe('parseRobots', () => {
  it('libera tudo sem regras', () => {
    expect(parseRobots('', 'autoestagio').isAllowed('/qualquer')).toBe(true);
  });

  it('aplica o grupo * quando não há grupo específico', () => {
    const policy = parseRobots('User-agent: *\nDisallow: /privado/', 'autoestagio');
    expect(policy.isAllowed('/privado/x')).toBe(false);
    expect(policy.isAllowed('/publico')).toBe(true);
  });

  it('prefere o grupo do próprio agente ao grupo *', () => {
    const body = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: AutoEstagio',
      'Disallow: /x',
    ].join('\n');
    const policy = parseRobots(body, 'autoestagio');
    expect(policy.isAllowed('/vagas')).toBe(true);
    expect(policy.isAllowed('/x/1')).toBe(false);
  });

  it('Disallow vazio não bloqueia nada', () => {
    expect(parseRobots('User-agent: *\nDisallow:', 'autoestagio').isAllowed('/a')).toBe(true);
  });

  it('a regra mais longa vence e allow vence o empate', () => {
    const policy = parseRobots(
      'User-agent: *\nDisallow: /api/\nAllow: /api/vagas\nDisallow: /tie\nAllow: /tie',
      'autoestagio',
    );
    expect(policy.isAllowed('/api/outro')).toBe(false);
    expect(policy.isAllowed('/api/vagas?x=1')).toBe(true);
    expect(policy.isAllowed('/tie')).toBe(true);
  });

  it('suporta curingas * e $', () => {
    const policy = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?sessao=', 'x');
    expect(policy.isAllowed('/docs/a.pdf')).toBe(false);
    expect(policy.isAllowed('/docs/a.pdf.html')).toBe(true);
    expect(policy.isAllowed('/lista?sessao=1')).toBe(false);
  });

  it('vários User-agent seguidos compartilham as regras e comentários são ignorados', () => {
    const body = 'User-agent: bot-a\nUser-agent: autoestagio # nós\nDisallow: /secreto # nada aqui';
    const policy = parseRobots(body, 'autoestagio');
    expect(policy.isAllowed('/secreto')).toBe(false);
  });

  it('lê Crawl-delay', () => {
    const policy = parseRobots('User-agent: *\nCrawl-delay: 5', 'autoestagio');
    expect(policy.crawlDelayMs).toBe(5000);
  });
});

describe('RobotsChecker', () => {
  const userAgent = 'AutoEstagio/0.1';
  const url = (path: string): URL => new URL(`https://empresa.com${path}`);

  it('permite e bloqueia conforme o arquivo, buscando uma vez por origem', async () => {
    const load = vi.fn(() =>
      Promise.resolve({ status: 200, body: 'User-agent: *\nDisallow: /admin' }),
    );
    const checker = new RobotsChecker({ userAgent, load });

    expect((await checker.check(url('/vagas'))).allowed).toBe(true);
    expect((await checker.check(url('/admin'))).allowed).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('https://empresa.com/robots.txt', undefined);
  });

  it('robots.txt inexistente (404) libera o acesso', async () => {
    const checker = new RobotsChecker({
      userAgent,
      load: () => Promise.resolve({ status: 404, body: '' }),
    });
    expect((await checker.check(url('/qualquer'))).allowed).toBe(true);
  });

  it.each([500, 503, 429])('status %i no robots.txt bloqueia por precaução', async (status) => {
    const checker = new RobotsChecker({
      userAgent,
      load: () => Promise.resolve({ status, body: '' }),
    });
    expect((await checker.check(url('/vagas'))).allowed).toBe(false);
  });

  it('falha de rede ao buscar o robots.txt bloqueia por precaução', async () => {
    const checker = new RobotsChecker({
      userAgent,
      load: () => Promise.reject(new Error('rede caiu')),
    });
    expect((await checker.check(url('/vagas'))).allowed).toBe(false);
  });

  it('informa o Crawl-delay', async () => {
    const checker = new RobotsChecker({
      userAgent,
      load: () => Promise.resolve({ status: 200, body: 'User-agent: *\nCrawl-delay: 3' }),
    });
    expect((await checker.check(url('/vagas'))).crawlDelayMs).toBe(3000);
  });

  it('refaz a busca depois que o cache expira', async () => {
    let now = 0;
    const load = vi.fn(() => Promise.resolve({ status: 200, body: '' }));
    const checker = new RobotsChecker({
      userAgent,
      load,
      ttlMs: 1000,
      clock: { now: () => now, sleep: () => Promise.resolve() },
    });
    await checker.check(url('/a'));
    now = 2000;
    await checker.check(url('/a'));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
