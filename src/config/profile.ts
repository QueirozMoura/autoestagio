import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigError } from './env.js';

/** Níveis de idioma, do menor ao maior. Ausente no perfil = desconhecido (nunca presumido). */
export const LANGUAGE_LEVELS = [
  'nenhum',
  'basico',
  'intermediario',
  'avancado',
  'fluente',
] as const;
export type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];

export const DEGREE_TYPES = ['tecnologo', 'bacharelado', 'licenciatura'] as const;

/**
 * Os campos opcionais abaixo só valem se o usuário os confirmou (ou se vêm do currículo
 * aprovado). Campo ausente significa "não informado": a análise de elegibilidade manda a vaga
 * para revisão humana em vez de supor um valor.
 */
export const profileSchema = z
  .object({
    name: z.string().min(1),
    city: z.string().min(1),
    education: z.object({
      course: z.string().min(1),
      institution: z.string().min(1),
      expectedGraduationYear: z.number().int().min(2000).max(2100),
      /** Mês previsto (1-12), quando confirmado. A análise ainda compara só o ano. */
      expectedGraduationMonth: z.number().int().min(1).max(12).optional(),
      degreeType: z.enum(DEGREE_TYPES).optional(),
      /** Semestre em curso, quando confirmado pelo usuário. */
      currentSemester: z.number().int().min(1).max(16).optional(),
    }),
    languages: z
      .array(
        z.object({
          language: z.string().min(1),
          level: z.enum(LANGUAGE_LEVELS),
          /**
           * `leitura-tecnica`: o nível vale só para leitura técnica e documentação; conversação e
           * escrita não estão comprovadas. `geral` (padrão): o nível vale para qualquer uso.
           */
          scope: z.enum(['geral', 'leitura-tecnica']).default('geral'),
        }),
      )
      .optional(),
    availability: z
      .object({
        hoursPerWeek: z
          .object({ min: z.number().int().min(1).max(60), max: z.number().int().min(1).max(60) })
          .refine((hours) => hours.min <= hours.max, 'min deve ser ≤ max'),
        /** Primeira data (AAAA-MM-DD) em que o usuário pode começar. */
        startFrom: z.iso.date(),
      })
      .optional(),
    /** Ponto de referência dos deslocamentos (só rótulo, ex.: "Guarapiranga, Zona Sul de São Paulo"). */
    home: z.object({ label: z.string().min(1).max(120) }).optional(),
    /**
     * Tempos de deslocamento verificados pelo usuário (por trecho). Só o que está aqui é
     * considerado "verificável"; local fora da lista = deslocamento desconhecido.
     */
    commute: z
      .array(
        z.object({
          /** Palavras que identificam o local na vaga (bairro, empresa), sem acento e minúsculas. */
          keywords: z.array(z.string().min(1)).min(1),
          minutesPerWay: z.number().int().positive(),
          /** Como foi verificado (ex.: "Google Maps, transporte público, 2026-10-22"). */
          source: z.string().min(1),
          /** Data (AAAA-MM-DD) em que VOCÊ confirmou o tempo. */
          confirmedAt: z.iso.date().optional(),
        }),
      )
      .optional(),
    /**
     * Projetos/experiências que o usuário confirmou poder citar nas mensagens, com o texto exato
     * aprovado. A mensagem nunca cita nada além disto e das demais seções do perfil.
     */
    highlights: z
      .array(
        z.object({
          title: z.string().min(1).max(120),
          summary: z.string().min(1).max(300),
          /** Precisam constar em `technologies` (nada comprovado só aqui). */
          technologies: z.array(z.string().min(1)).default([]),
        }),
      )
      .optional(),
    /** Presente somente depois que o usuário aprova o perfil extraído do currículo. */
    approval: z
      .object({
        cvFile: z.string().min(1),
        /** SHA-256 (hex) do PDF aprovado: identifica a versão exata do currículo. */
        cvSha256: z.string().regex(/^[0-9a-f]{64}$/, 'use 64 caracteres hexadecimais minúsculos'),
        approvedAt: z.iso.date(),
      })
      .optional(),
    level: z.enum(['estagio', 'junior']),
    areas: z.array(z.string().min(1)).min(1),
    technologies: z.array(z.string().min(1)).min(1),
    workModes: z.object({
      preferred: z.array(z.enum(['remoto', 'hibrido', 'presencial'])).min(1),
      onsite: z.object({
        allowed: z.boolean(),
        /** Até este tempo por trecho o deslocamento é adequado. */
        maxCommuteMinutesPerWay: z.number().int().positive(),
        /** Acima do limite e até este tempo: revisão manual (padrão: limite + 10). Acima: incompatível. */
        reviewMaxCommuteMinutesPerWay: z.number().int().positive().optional(),
      }),
    }),
    minStipend: z.object({
      amount: z.number().nonnegative(),
      currency: z.string().length(3),
      /** Vagas sem valor informado ficam pendentes de análise manual; nunca são descartadas. */
      whenUnknown: z.literal('pendente'),
    }),
  })
  .superRefine((profile, ctx) => {
    const known = new Set(profile.technologies.map((name) => name.toLowerCase()));
    profile.highlights?.forEach((highlight, index) => {
      for (const name of highlight.technologies) {
        if (!known.has(name.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path: ['highlights', index, 'technologies'],
            message: `"${name}" não consta em technologies`,
          });
        }
      }
    });
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
