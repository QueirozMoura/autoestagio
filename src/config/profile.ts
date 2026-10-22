import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './env.js';

export const profileSchema = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
  education: z.object({
    course: z.string().min(1),
    institution: z.string().min(1),
    expectedGraduationYear: z.number().int().min(2000).max(2100),
  }),
  level: z.enum(['estagio', 'junior']),
  areas: z.array(z.string().min(1)).min(1),
  technologies: z.array(z.string().min(1)).min(1),
  workModes: z.object({
    preferred: z.array(z.enum(['remoto', 'hibrido', 'presencial'])).min(1),
    onsite: z.object({
      allowed: z.boolean(),
      maxCommuteMinutesPerWay: z.number().int().positive(),
    }),
  }),
  minStipend: z.object({
    amount: z.number().nonnegative(),
    currency: z.string().length(3),
    /** Vagas sem valor informado ficam pendentes de análise manual. */
    whenUnknown: z.enum(['pendente', 'descartar']),
  }),
});

export type Profile = z.infer<typeof profileSchema>;

export function parseProfile(data: unknown): Profile {
  const result = profileSchema.safeParse(data);
  if (!result.success) {
    throw new ConfigError('Perfil inválido', result.error);
  }
  return result.data;
}

/** Retorna `undefined` se o arquivo não existir; lança `ConfigError` se for inválido. */
export function loadProfile(path: string): Profile | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Não foi possível ler o perfil em ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  return parseProfile(raw);
}
