import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { PROJECT_ROOT } from '../utils/paths.js';

/**
 * Dados do candidato usados nos formulários (config/applicant.json, fora do Git). Só entra aqui o que você informou
 * ou que consta no seu currículo; o executor NUNCA inventa nem completa um dado ausente.
 */
const phone = z
  .string()
  .regex(/^\+[1-9]\d{9,14}$/, 'use o formato internacional, ex.: +5511999999999');

export const applicantSchema = z.strictObject({
  fullName: z.string().min(3),
  email: z.email(),
  /** Formato internacional (E.164). */
  phone,
  city: z.string().min(1),
  state: z.string().min(1).optional(),
  country: z.string().min(1).default('Brasil'),
  linkedin: z.url().optional(),
  github: z.url().optional(),
  portfolio: z.url().optional(),
  /** De onde cada dado veio (auditoria). */
  provenance: z.string().min(1).default('informado pelo usuário'),
});
export type Applicant = z.infer<typeof applicantSchema>;

export const DEFAULT_APPLICANT_PATH = `${PROJECT_ROOT}/config/applicant.json`;

export class ApplicantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicantError';
  }
}

export function parseApplicant(raw: unknown): Applicant {
  const parsed = applicantSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApplicantError(
      `config/applicant.json inválido em "${issue?.path.join('.') ?? ''}": ${issue?.message ?? 'erro'}.`,
    );
  }
  return parsed.data;
}

export function loadApplicant(path: string = DEFAULT_APPLICANT_PATH): Applicant {
  if (!existsSync(path))
    throw new ApplicantError(
      'config/applicant.json não existe (veja config/applicant.example.json).',
    );
  try {
    return parseApplicant(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof ApplicantError) throw error;
    throw new ApplicantError('config/applicant.json não é um JSON válido.');
  }
}

export const nameParts = (fullName: string): { first: string; last: string } => {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
};

export const maskEmail = (email: string): string => {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 2)}…@${domain}`;
};
export const maskPhone = (value: string): string => `…${value.slice(-4)}`;
