import { z } from 'zod';

export const APPLY_MODES = ['dry-run', 'manual', 'auto'] as const;
export type ApplyMode = (typeof APPLY_MODES)[number];

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const envSchema = z
  .object({
    DATABASE_PATH: z.string().min(1).default('data/autoestagio.db'),
    PROFILE_PATH: z.string().min(1).default('config/profile.json'),
    APPLY_MODE: z.enum(APPLY_MODES).default('dry-run'),
    ALLOW_AUTO_APPLY: booleanString,
    MAX_APPLICATIONS_PER_DAY: z.coerce.number().int().min(0).max(100).default(10),
  })
  .superRefine((env, ctx) => {
    if (env.APPLY_MODE !== 'auto') return;
    if (!env.ALLOW_AUTO_APPLY) {
      ctx.addIssue({
        code: 'custom',
        path: ['APPLY_MODE'],
        message: 'o modo "auto" exige ALLOW_AUTO_APPLY=true (desabilitado por padrão)',
      });
    }
    // Trava de segurança: o modo automático será implementado em etapa futura.
    ctx.addIssue({
      code: 'custom',
      path: ['APPLY_MODE'],
      message: 'o modo "auto" ainda não foi implementado; use "dry-run" ou "manual"',
    });
  });

export interface AppConfig {
  databasePath: string;
  profilePath: string;
  applyMode: ApplyMode;
  allowAutoApply: boolean;
  maxApplicationsPerDay: number;
}

export function parseEnv(source: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new ConfigError('Variáveis de ambiente inválidas', result.error);
  }
  const env = result.data;
  return {
    databasePath: env.DATABASE_PATH,
    profilePath: env.PROFILE_PATH,
    applyMode: env.APPLY_MODE,
    allowAutoApply: env.ALLOW_AUTO_APPLY,
    maxApplicationsPerDay: env.MAX_APPLICATIONS_PER_DAY,
  };
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, error: z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    super(`${message}:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
