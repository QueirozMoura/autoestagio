import type { Clock } from './rate-limit.js';
import { systemClock } from './rate-limit.js';

export interface RobotsPolicy {
  isAllowed(pathAndQuery: string): boolean;
  crawlDelayMs?: number | undefined;
}

export const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };
export const DISALLOW_ALL: RobotsPolicy = { isAllowed: () => false };

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelayMs?: number;
}

function compilePattern(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Extrai o token do produto do User-Agent: "AutoEstagio/0.1 (...)" → "autoestagio". */
export function productToken(userAgent: string): string {
  return (userAgent.split(/[\s/]/)[0] ?? '').toLowerCase();
}

/** Interpreta um robots.txt (RFC 9309) para o agente informado. */
export function parseRobots(body: string, agentToken: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if (field === 'allow' || field === 'disallow') {
      // "Disallow:" vazio não restringe nada.
      if (value !== '') {
        current.rules.push({
          allow: field === 'allow',
          pattern: compilePattern(value),
          length: value.length,
        });
      }
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = seconds * 1000;
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.filter((group) => group.agents.includes(token));
  const matching = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = matching.flatMap((group) => group.rules);
  const crawlDelayMs = matching.find((group) => group.crawlDelayMs !== undefined)?.crawlDelayMs;

  return {
    crawlDelayMs,
    isAllowed(pathAndQuery) {
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!rule.pattern.test(pathAndQuery)) continue;
        // A regra mais específica (mais longa) vence; em empate, "allow" vence.
        if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}

export interface RobotsLoadResult {
  status: number;
  body: string;
}

export interface RobotsCheckerOptions {
  userAgent: string;
  /** Baixa o robots.txt. Deve lançar em falhas de rede; status HTTP vem em `status`. */
  load: (robotsUrl: string, signal?: AbortSignal) => Promise<RobotsLoadResult>;
  ttlMs?: number;
  clock?: Clock;
}

export interface RobotsDecision {
  allowed: boolean;
  reason?: string;
  crawlDelayMs?: number | undefined;
}

/** Busca, interpreta e guarda em cache o robots.txt de cada origem. */
export class RobotsChecker {
  private readonly cache = new Map<string, { expiresAt: number; policy: Promise<RobotsPolicy> }>();
  private readonly token: string;
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(private readonly options: RobotsCheckerOptions) {
    this.token = productToken(options.userAgent);
    this.clock = options.clock ?? systemClock;
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  }

  async check(url: URL, signal?: AbortSignal): Promise<RobotsDecision> {
    const policy = await this.policyFor(url.origin, signal);
    if (!policy.isAllowed(url.pathname + url.search)) {
      return { allowed: false, reason: 'caminho bloqueado' };
    }
    return { allowed: true, crawlDelayMs: policy.crawlDelayMs };
  }

  private policyFor(origin: string, signal?: AbortSignal): Promise<RobotsPolicy> {
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > this.clock.now()) return cached.policy;

    const policy = this.load(origin, signal);
    this.cache.set(origin, { expiresAt: this.clock.now() + this.ttlMs, policy });
    // Falhas de abortar não devem ficar em cache.
    policy.catch(() => this.cache.delete(origin));
    return policy;
  }

  private async load(origin: string, signal?: AbortSignal): Promise<RobotsPolicy> {
    let result: RobotsLoadResult;
    try {
      result = await this.options.load(`${origin}/robots.txt`, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // Sem conseguir ler o robots.txt, a postura é conservadora: não acessar.
      return DISALLOW_ALL;
    }
    if (result.status >= 200 && result.status < 300) return parseRobots(result.body, this.token);
    // RFC 9309: 4xx = arquivo inexistente (livre); 5xx e 429 = indisponível (não acessar).
    if (result.status === 429 || result.status >= 500) return DISALLOW_ALL;
    return ALLOW_ALL;
  }
}
