import { beforeAll, describe, expect, it } from 'vitest';
import { verifyLinks, type CvMaster } from '../../src/cv/index.js';
import { setup } from '../helpers/adapters.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { jsonResponse, textResponse } from '../helpers/mock-fetch.js';

let L: Loaded;
beforeAll(async () => {
  L = await loadFictional();
});

/** Modelo fictício com os links apontando para github.com / linkedin.com / hosts de demo (todos simulados). */
function withUrls(): CvMaster {
  const m = structuredClone(L.model);
  const set = (id: string, url: string): void => {
    for (const link of [
      ...m.identity.links,
      ...m.experience.flatMap((e) => e.links),
      ...m.projects.flatMap((e) => e.links),
    ])
      if (link.id === id) link.url = url;
  };
  set('link-linkedin', 'https://www.linkedin.com/in/maria-exemplo-/');
  set('link-github', 'https://github.com/maria-exemplo');
  set('link-portfolio', 'https://maria-exemplo.example.dev/');
  set('exp-oficina-exemplo-ltda-link-demo', 'https://oficina-exemplo.example.app/');
  set('exp-oficina-exemplo-ltda-link-github', 'https://github.com/maria-exemplo/oficina-');
  set('exp-agendamais-link-demo', 'https://agenda-exemplo.example.app/');
  set('exp-agendamais-link-github', 'https://github.com/maria-exemplo/agenda');
  set('proj-notasfacil-link-github', 'https://github.com/maria-exemplo/notas');
  return m;
}

const repo = (name: string, homepage: string | null, extra: Record<string, unknown> = {}) => ({
  name: name.split('/')[1],
  full_name: name,
  html_url: `https://github.com/${name}`,
  private: false,
  archived: false,
  description: 'Projeto fictício',
  language: 'TypeScript',
  pushed_at: '2026-10-01T10:00:00Z',
  homepage,
  ...extra,
});
const html = (title: string, body = ''): Response =>
  textResponse(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
const readme = (text: string) =>
  jsonResponse({ content: Buffer.from(text).toString('base64'), encoding: 'base64' });
const ALLOW = () => textResponse('User-agent: *\nAllow: /');

function routes(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    'https://www.linkedin.com/robots.txt': () => textResponse('User-agent: *\nDisallow: /'),
    'https://github.com/robots.txt': ALLOW,
    'https://maria-exemplo.example.dev/robots.txt': ALLOW,
    'https://oficina-exemplo.example.app/robots.txt': ALLOW,
    'https://agenda-exemplo.example.app/robots.txt': ALLOW,
    'https://maria-exemplo.example.dev/': () =>
      html(
        'portfolio',
        '<a href="https://github.com/maria-exemplo">GH</a><a href="https://www.linkedin.com/in/maria-exemplo-/">LI</a>',
      ),
    'https://oficina-exemplo.example.app/': () => html('Oficina Exemplo'),
    'https://agenda-exemplo.example.app/': () => html('Agenda'),
    'https://github.com/maria-exemplo': () => html('maria-exemplo · GitHub'),
    'https://github.com/maria-exemplo/oficina-': () => html('GitHub - oficina-'),
    'https://github.com/maria-exemplo/agenda': () => html('GitHub - agenda'),
    'https://github.com/maria-exemplo/notas': () => html('GitHub - notas'),
    'https://api.github.com/users/maria-exemplo': () =>
      jsonResponse({
        login: 'maria-exemplo',
        html_url: 'https://github.com/maria-exemplo',
        blog: 'https://maria-exemplo.example.dev/',
      }),
    'https://api.github.com/users/maria-exemplo/social_accounts': () =>
      jsonResponse([{ provider: 'linkedin', url: 'https://www.linkedin.com/in/maria-exemplo-/' }]),
    'https://api.github.com/repos/maria-exemplo/oficina-': () =>
      jsonResponse(repo('maria-exemplo/oficina-', 'https://oficina-exemplo.example.app/')),
    'https://api.github.com/repos/maria-exemplo/oficina': () => textResponse('{}', { status: 404 }),
    'https://api.github.com/repos/maria-exemplo/oficina-/readme': () =>
      readme('Autenticação JWT, validação HMAC e deploy.'),
    'https://api.github.com/repos/maria-exemplo/agenda': () =>
      jsonResponse(repo('maria-exemplo/agenda', 'https://agenda-exemplo.example.app/')),
    'https://api.github.com/repos/maria-exemplo/agenda/readme': () =>
      readme('exclusion constraint no PostgreSQL.'),
    'https://api.github.com/repos/maria-exemplo/notas': () =>
      jsonResponse(repo('maria-exemplo/notas', null)),
    'https://api.github.com/repos/maria-exemplo/notas/readme': () =>
      readme('300 testes no frontend e 300 no backend.'),
    ...overrides,
  };
}

const run = async (r = routes(), model = withUrls()) => {
  const ctx = setup(r);
  const checks = await verifyLinks(model, { http: ctx.client, claims: L.enriched.claims });
  return { checks, ...ctx };
};
const byId = (checks: Awaited<ReturnType<typeof run>>['checks'], id: string) => {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`sem ${id}`);
  return found;
};

describe('verifyLinks (HTTP simulado; nenhuma requisição real)', () => {
  it('confere cada link, traz evidências e NUNCA confirma nada nem altera o modelo', async () => {
    const model = withUrls();
    const before = JSON.stringify(model);
    const { checks } = await run(routes(), model);
    expect(checks).toHaveLength(8);
    expect(JSON.stringify(model)).toBe(before);
    for (const c of checks) expect(c.confirmedByUser).toBe(false);
    expect(model.identity.links.every((l) => !l.confirmedByUser && l.status === 'rascunho')).toBe(
      true,
    );
  });

  it('páginas que respondem: acessível, com título e sem redirecionamento', async () => {
    const { checks } = await run();
    expect(byId(checks, 'exp-oficina-exemplo-ltda-link-demo')).toMatchObject({
      verdict: 'acessivel',
      http: { status: 200, redirected: false, title: 'Oficina Exemplo' },
    });
    expect(byId(checks, 'link-github')).toMatchObject({
      verdict: 'acessivel',
      github: { kind: 'usuario', exists: true, canonicalName: 'maria-exemplo' },
    });
  });

  it('LinkedIn: o robots.txt proíbe, então NENHUMA requisição é feita ao perfil (inconclusivo)', async () => {
    const { checks, calls } = await run();
    const linkedin = byId(checks, 'link-linkedin');
    expect(linkedin.verdict).toBe('inconclusivo');
    expect(linkedin.http !== undefined && 'error' in linkedin.http && linkedin.http.error).toMatch(
      /robots\.txt/,
    );
    expect(linkedin.notes.join(' ')).toMatch(/confira este link manualmente/);
    expect(
      calls.map((c) => c.url).filter((u) => u.startsWith('https://www.linkedin.com/in/')),
    ).toEqual([]);
  });

  it('hífen final: sinaliza, sonda a versão sem hífen como EVIDÊNCIA e não substitui o endereço', async () => {
    const { checks } = await run();
    const repoCheck = byId(checks, 'exp-oficina-exemplo-ltda-link-github');
    expect(repoCheck.endsWithHyphen).toBe(true);
    expect(repoCheck.url).toBe('https://github.com/maria-exemplo/oficina-');
    expect(repoCheck.github?.canonicalName).toBe('maria-exemplo/oficina-');
    expect(repoCheck.github?.withoutHyphen).toEqual({
      url: 'https://github.com/maria-exemplo/oficina',
      exists: false,
    });
    expect(repoCheck.notes.join(' ')).toMatch(/hífen faz parte do nome do repositório/);
    expect(byId(checks, 'link-linkedin').endsWithHyphen).toBe(true);
  });

  it('se a versão sem hífen também existe, avisa que há dois candidatos (sem escolher)', async () => {
    const { checks } = await run(
      routes({
        'https://api.github.com/repos/maria-exemplo/oficina': () =>
          jsonResponse(repo('maria-exemplo/oficina', null)),
      }),
    );
    expect(byId(checks, 'exp-oficina-exemplo-ltda-link-github').notes.join(' ')).toMatch(
      /Existe também um repositório SEM o hífen/,
    );
  });

  it('corroboração cruzada: homepage do repositório = demo; GitHub e portfólio declaram o mesmo LinkedIn', async () => {
    const { checks } = await run();
    expect(byId(checks, 'exp-oficina-exemplo-ltda-link-demo').corroboration.join(' ')).toMatch(
      /declara esta demo como homepage/,
    );
    expect(byId(checks, 'exp-oficina-exemplo-ltda-link-github').corroboration.join(' ')).toMatch(
      /homepage.*aponta para a demo/,
    );
    const linkedin = byId(checks, 'link-linkedin').corroboration.join(' ');
    expect(linkedin).toMatch(/perfil do GitHub declara este mesmo LinkedIn/);
    expect(linkedin).toMatch(/portfólio aponta para este mesmo endereço/);
  });

  it('README: termos do currículo encontrados e não encontrados (indício, não prova)', async () => {
    const { checks } = await run();
    expect(byId(checks, 'exp-oficina-exemplo-ltda-link-github').github?.readme).toEqual({
      found: ['HMAC'],
      notFound: [],
    });
    const agenda = byId(checks, 'exp-agendamais-link-github').github?.readme;
    expect(agenda?.found).toContain('exclusion constraint');
    expect(agenda?.notFound).toContain('testes de concorrência');
    expect(byId(checks, 'proj-notasfacil-link-github').github?.readme?.found).toEqual(
      expect.arrayContaining(['300']),
    );
  });

  it('falhas isoladas: 404, anti-bot (403), 5xx e rede não impedem os demais links', async () => {
    const { checks } = await run(
      routes({
        'https://oficina-exemplo.example.app/': () => textResponse('', { status: 404 }),
        'https://agenda-exemplo.example.app/': () => textResponse('', { status: 403 }),
        'https://maria-exemplo.example.dev/': () => textResponse('', { status: 503 }),
        'https://api.github.com/repos/maria-exemplo/notas': () => textResponse('', { status: 404 }),
      }),
    );
    expect(byId(checks, 'exp-oficina-exemplo-ltda-link-demo')).toMatchObject({
      verdict: 'inacessivel',
      http: { error: 'HTTP 404' },
    });
    expect(byId(checks, 'exp-agendamais-link-demo')).toMatchObject({
      verdict: 'inconclusivo',
      http: { error: 'HTTP 403' },
    });
    expect(byId(checks, 'link-portfolio').verdict).toBe('inacessivel');
    const notas = byId(checks, 'proj-notasfacil-link-github');
    expect(notas.verdict).toBe('inacessivel');
    expect(notas.notes.join(' ')).toMatch(/GitHub responde 404/);
    expect(byId(checks, 'link-github').verdict).toBe('acessivel'); // os outros seguem normais
  });

  it('limite da API do GitHub (403): não derruba a verificação, só avisa', async () => {
    const { checks } = await run(
      routes({
        'https://api.github.com/repos/maria-exemplo/agenda': () =>
          textResponse('', { status: 403 }),
      }),
    );
    const agenda = byId(checks, 'exp-agendamais-link-github');
    expect(agenda.notes.join(' ')).toMatch(/Não foi possível consultar a API do GitHub/);
    expect(agenda.http).toMatchObject({ status: 200 });
  });

  it('só leitura: somente GET, sem credenciais, sem seguir para fora do necessário', async () => {
    const { calls } = await run();
    expect(new Set(calls.map((c) => c.init?.method))).toEqual(new Set(['GET']));
    for (const c of calls) {
      const headers = JSON.stringify(c.init?.headers ?? {}).toLowerCase();
      expect(headers).not.toMatch(/authorization|cookie|token/);
    }
    expect(
      calls
        .filter((c) => c.url.startsWith('https://api.github.com/'))
        .every((c) => /\/(users|repos)\//.test(c.url)),
    ).toBe(true);
  });
});
