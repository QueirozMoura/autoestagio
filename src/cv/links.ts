import { z } from 'zod';
import { HttpStatusError, RobotsDisallowedError, type HttpClient } from '../http/index.js';
import type { Claim, CvMaster } from './schema.js';

/**
 * Conferência dos links do currículo. Mostra EVIDÊNCIAS (o endereço responde? o repositório existe
 * com esse nome exato? o repositório e o portfólio apontam para o mesmo lugar?). Não aprova nada e
 * não corrige nem substitui nenhum endereço: `confirmedByUser` continua falso até você confirmar.
 */
export type LinkVerdict = 'acessivel' | 'inconclusivo' | 'inacessivel';

export interface LinkCheck {
  id: string;
  label: string;
  url: string;
  scope: string;
  https: boolean;
  /** O último trecho do caminho termina em hífen (pode estar certo ou truncado). */
  endsWithHyphen: boolean;
  http?:
    { status: number; finalUrl: string; redirected: boolean; title?: string } | { error: string };
  github?: {
    kind: 'usuario' | 'repositorio';
    exists: boolean;
    /** Nome exato (com maiúsculas e hífens) devolvido pela API do GitHub. */
    canonicalName?: string;
    description?: string | null;
    language?: string | null;
    pushedAt?: string;
    homepage?: string | null;
    archived?: boolean;
    private?: boolean;
    /** Sondagem do endereço sem o hífen final: só evidência, nunca substituição. */
    withoutHyphen?: { url: string; exists: boolean };
    readme?: { found: string[]; notFound: string[] };
    linkedinOnProfile?: string;
  };
  corroboration: string[];
  verdict: LinkVerdict;
  notes: string[];
  /** Sempre falso aqui: só o usuário confirma. */
  confirmedByUser: false;
}

const repoSchema = z.object({
  name: z.string(),
  full_name: z.string(),
  html_url: z.string(),
  private: z.boolean(),
  archived: z.boolean(),
  description: z.string().nullish(),
  language: z.string().nullish(),
  pushed_at: z.string().nullish(),
  homepage: z.string().nullish(),
});
const userSchema = z.object({
  login: z.string(),
  html_url: z.string(),
  blog: z.string().nullish(),
});
const socialSchema = z.array(z.object({ provider: z.string(), url: z.string() }));
const readmeSchema = z.object({ content: z.string(), encoding: z.string() });

const API = 'https://api.github.com';
const ANTI_BOT = new Set([401, 403, 429, 999]);

const norm = (url: string): string =>
  url
    .trim()
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/+$/, '')
    .toLowerCase();

function title(html: string): string | undefined {
  const match = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  return match?.[1]?.replace(/\s+/g, ' ').trim();
}

interface Target {
  link: CvMaster['identity']['links'][number];
  scope: string;
  terms: string[];
}

/** Termos de afirmações (números de testes e técnicas) para procurar no README do repositório. */
function termsFor(entryId: string, claims: readonly Claim[]): string[] {
  const terms = new Set<string>();
  for (const claim of claims) {
    if (!(claim.blockId === entryId || claim.blockId.startsWith(`${entryId}-`))) continue;
    if (claim.kind === 'tecnica_especifica')
      for (const t of claim.quote.split(' · ')) terms.add(t.trim());
    if (claim.kind === 'numero_testes')
      for (const n of claim.quote.match(/\d[\d.]*/g) ?? []) terms.add(n);
  }
  return [...terms].filter((t) => t.length >= 2);
}

export interface VerifyOptions {
  http: HttpClient;
  claims: readonly Claim[];
  signal?: AbortSignal;
}

export async function verifyLinks(model: CvMaster, options: VerifyOptions): Promise<LinkCheck[]> {
  const { http, claims } = options;
  const signal = options.signal;
  const requestOptions = signal === undefined ? {} : { signal };
  const targets: Target[] = [
    ...model.identity.links.map((link) => ({ link, scope: 'cabecalho', terms: [] as string[] })),
    ...[...model.experience, ...model.projects].flatMap((entry) =>
      entry.links.map((link) => ({ link, scope: entry.id, terms: termsFor(entry.id, claims) })),
    ),
  ];

  const results: LinkCheck[] = [];
  const repoInfo = new Map<string, z.infer<typeof repoSchema> | null>();
  let githubUser:
    { login: string; blog?: string | null | undefined; linkedin?: string | undefined } | undefined;
  let portfolioLinks: Set<string> | undefined;

  for (const { link, scope, terms } of targets) {
    const url = new URL(link.url);
    const check: LinkCheck = {
      id: link.id,
      label: link.label,
      url: link.url,
      scope,
      https: url.protocol === 'https:',
      endsWithHyphen: /-\/?$/.test(url.pathname) || /-$/.test(url.hostname.split('.')[0] ?? ''),
      corroboration: [],
      verdict: 'inconclusivo',
      notes: [],
      confirmedByUser: false,
    };
    if (!check.https) check.notes.push('O endereço não usa HTTPS.');
    if (check.endsWithHyphen)
      check.notes.push(
        'O endereço termina com hífen (pode estar certo ou truncado). Nada foi corrigido.',
      );

    // ---- 1) a página responde?
    try {
      const response = await http.request(link.url, requestOptions);
      const finalUrl = response.url;
      const pageTitle = title(response.text);
      check.http = {
        status: response.status,
        finalUrl,
        redirected: norm(finalUrl) !== norm(link.url),
        ...(pageTitle === undefined ? {} : { title: pageTitle }),
      };
      check.verdict = 'acessivel';
      if (check.http.redirected) check.notes.push(`Redirecionou para ${finalUrl}.`);
      if (url.hostname.endsWith('.dev') || (scope === 'cabecalho' && /portf/i.test(link.label))) {
        portfolioLinks = new Set(
          [...response.text.matchAll(/href=["']([^"']+)["']/gi)].map((m) => norm(m[1] ?? '')),
        );
      }
    } catch (error) {
      if (error instanceof RobotsDisallowedError) {
        check.http = {
          error: 'robots.txt do site proíbe leitura automatizada; nenhuma requisição foi feita',
        };
        check.notes.push(
          'O site não permite leitura automatizada: confira este link manualmente no navegador.',
        );
      } else if (error instanceof HttpStatusError) {
        check.http = { error: `HTTP ${error.status}` };
        if (ANTI_BOT.has(error.status)) {
          check.notes.push(
            'O site bloqueia leitura automatizada (resposta típica de anti-bot): inconclusivo, confira manualmente.',
          );
        } else {
          check.verdict = 'inacessivel';
        }
      } else {
        check.http = {
          error: error instanceof Error ? error.message.slice(0, 120) : 'erro desconhecido',
        };
        check.verdict = 'inacessivel';
      }
    }

    // ---- 2) GitHub: usuário/repositório existem, com este nome exato?
    if (url.hostname === 'github.com') {
      const [owner, repo] = url.pathname.split('/').filter((p) => p !== '');
      const github: NonNullable<LinkCheck['github']> = {
        kind: repo === undefined ? 'usuario' : 'repositorio',
        exists: false,
      };
      check.github = github;
      try {
        if (owner !== undefined && repo === undefined) {
          const user = await http.getJson(`${API}/users/${encodeURIComponent(owner)}`, userSchema, {
            respectRobots: false,
            ...requestOptions,
          });
          github.exists = true;
          github.canonicalName = user.login;
          githubUser = { login: user.login, blog: user.blog };
          try {
            const social = await http.getJson(
              `${API}/users/${encodeURIComponent(owner)}/social_accounts`,
              socialSchema,
              { respectRobots: false, ...requestOptions },
            );
            const linkedin = social.find((s) => s.provider === 'linkedin');
            if (linkedin !== undefined) {
              githubUser.linkedin = linkedin.url;
              github.linkedinOnProfile = linkedin.url;
            }
          } catch {
            check.notes.push('Não foi possível ler as contas sociais do perfil do GitHub.');
          }
        } else if (owner !== undefined && repo !== undefined) {
          const data = await http.getJson(
            `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
            repoSchema,
            { respectRobots: false, ...requestOptions },
          );
          repoInfo.set(norm(link.url), data);
          github.exists = true;
          github.canonicalName = data.full_name;
          github.description = data.description ?? null;
          github.language = data.language ?? null;
          if (data.pushed_at != null) github.pushedAt = data.pushed_at;
          github.homepage = data.homepage ?? null;
          github.archived = data.archived;
          github.private = data.private;
          if (data.full_name !== `${owner}/${repo}`)
            check.notes.push(
              `O GitHub devolve o nome exato "${data.full_name}" (diferente do escrito no currículo).`,
            );
          if (terms.length > 0) {
            try {
              const readme = await http.getJson(
                `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
                readmeSchema,
                { respectRobots: false, ...requestOptions },
              );
              const text =
                readme.encoding === 'base64'
                  ? Buffer.from(readme.content, 'base64').toString('utf8').toLowerCase()
                  : '';
              github.readme = {
                found: terms.filter((t) => text.includes(t.toLowerCase())),
                notFound: terms.filter((t) => !text.includes(t.toLowerCase())),
              };
            } catch {
              check.notes.push('Repositório sem README legível pela API.');
            }
          }
        }
        check.verdict = 'acessivel';
      } catch (error) {
        github.exists = false;
        if (error instanceof HttpStatusError && error.status === 404) {
          check.verdict = 'inacessivel';
          check.notes.push(
            'O GitHub responde 404: o usuário/repositório não existe (ou é privado) com este nome.',
          );
        } else {
          check.notes.push(
            'Não foi possível consultar a API do GitHub (limite de requisições ou rede).',
          );
        }
      }
      // Evidência sobre o hífen final: o endereço SEM o hífen existe? (não substitui nada)
      if (
        github.kind === 'repositorio' &&
        /-$/.test(repo ?? '') &&
        owner !== undefined &&
        repo !== undefined
      ) {
        const bare = repo.replace(/-+$/, '');
        const probeUrl = `https://github.com/${owner}/${bare}`;
        try {
          await http.getJson(
            `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(bare)}`,
            repoSchema,
            { respectRobots: false, ...requestOptions },
          );
          github.withoutHyphen = { url: probeUrl, exists: true };
          check.notes.push(
            `Existe também um repositório SEM o hífen (${probeUrl}): confirme qual é o correto.`,
          );
        } catch (error) {
          github.withoutHyphen = {
            url: probeUrl,
            exists: !(error instanceof HttpStatusError && error.status === 404) ? false : false,
          };
          if (error instanceof HttpStatusError && error.status === 404)
            check.notes.push(
              'O endereço sem o hífen final não existe: o hífen faz parte do nome do repositório.',
            );
        }
      }
    }
    results.push(check);
  }

  // ---- 3) Corroboração cruzada.
  for (const check of results) {
    if (check.github?.kind === 'repositorio' && check.github.homepage != null) {
      const demo = results.find((r) => r.scope === check.scope && /demo/i.test(r.label));
      if (demo !== undefined && norm(check.github.homepage) === norm(demo.url)) {
        check.corroboration.push(
          `O campo "homepage" do repositório aponta para a demo do currículo (${demo.url}).`,
        );
        demo.corroboration.push(
          `O repositório ${check.github.canonicalName ?? ''} declara esta demo como homepage.`,
        );
      }
    }
    if (
      /linkedin/i.test(check.label) &&
      githubUser?.linkedin !== undefined &&
      norm(githubUser.linkedin) === norm(check.url)
    ) {
      check.corroboration.push('O perfil do GitHub declara este mesmo LinkedIn.');
    }
    if (
      portfolioLinks !== undefined &&
      /linkedin|github/i.test(check.label) &&
      check.scope === 'cabecalho' &&
      portfolioLinks.has(norm(check.url))
    ) {
      check.corroboration.push('O site de portfólio aponta para este mesmo endereço.');
    }
    if (/github/i.test(check.label) && check.scope === 'cabecalho' && githubUser?.blog != null) {
      const portfolio = results.find((r) => /portf/i.test(r.label));
      if (portfolio !== undefined && norm(githubUser.blog) === norm(portfolio.url))
        check.corroboration.push('O perfil do GitHub aponta para o mesmo portfólio do currículo.');
    }
  }
  return results;
}
