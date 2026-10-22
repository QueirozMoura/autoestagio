import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../config/env.js';
import { DEFAULT_USER_AGENT } from '../http/index.js';
import { PROJECT_ROOT } from '../utils/paths.js';

export const DEFAULT_SOURCES_PATH = join(PROJECT_ROOT, 'config', 'sources.json');

/** Tipos de fonte conhecidos. Cada um precisa de um adaptador registrado para ser usado. */
export const SOURCE_KINDS = [
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'career-page',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

const httpSchema = z.object({
  userAgent: z.string().min(1).default(DEFAULT_USER_AGENT),
  timeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
  maxRetries: z.number().int().min(0).max(5).default(3),
  /** Intervalo mínimo entre requisições ao mesmo host. */
  minIntervalMs: z.number().int().min(500).max(60_000).default(2_000),
  maxRetryAfterMs: z.number().int().min(0).max(300_000).default(60_000),
  maxResponseBytes: z.number().int().min(1_024).max(20_971_520).default(5_242_880),
  respectRobots: z.boolean().default(true),
});

const limitsSchema = z.object({
  maxJobsPerSource: z.number().int().min(1).max(5_000).default(500),
  maxPagesPerSource: z.number().int().min(1).max(100).default(20),
});

const targetSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  /** Identificador da empresa na plataforma, por exemplo o "board token" do Greenhouse. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'use letras, números, ".", "_" ou "-"'),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Sobrescreve a verificação de robots.txt apenas para este alvo. */
  respectRobots: z.boolean().optional(),
  /** Guarda apenas vagas no Brasil (ou LATAM). Use `false` para empresas só de vagas locais. */
  brazilOnly: z.boolean().default(true),
  /** Lever: instância dos dados da empresa. Contas europeias usam `api.eu.lever.co`. */
  instance: z.enum(['global', 'eu']).default('global'),
});

export const sourcesConfigSchema = z
  .object({
    http: httpSchema.default(() => httpSchema.parse({})),
    limits: limitsSchema.default(() => limitsSchema.parse({})),
    targets: z.array(targetSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.targets.forEach((target, index) => {
      if (target.instance === 'eu' && target.kind !== 'lever') {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', index, 'instance'],
          message: '"eu" só se aplica ao Lever',
        });
      }
      const key = `${target.kind}:${target.slug.toLowerCase()}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['targets', index, 'slug'],
          message: `alvo duplicado: ${key}`,
        });
      }
      seen.add(key);
    });
  });

export type SourcesConfig = z.infer<typeof sourcesConfigSchema>;
export type SourceTarget = SourcesConfig['targets'][number];

export function parseSourcesConfig(data: unknown): SourcesConfig {
  const result = sourcesConfigSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError('Configuração de fontes inválida', result.error);
  }
  return result.data;
}

/** Sem arquivo, usa a configuração padrão (sem alvos). Arquivo inválido lança `ConfigError`. */
export function loadSourcesConfig(path: string = DEFAULT_SOURCES_PATH): SourcesConfig {
  if (!existsSync(path)) return parseSourcesConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Não foi possível ler as fontes em ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return parseSourcesConfig(raw);
}
