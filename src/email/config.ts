import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { isValidEmail } from './mime.js';

const emailConfigSchema = z.object({
  /** Sua caixa de teste: os envios de teste vão só para ela. */
  testMailbox: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .refine(isValidEmail, 'endereço inválido')
    .optional(),
});

export type EmailConfig = z.infer<typeof emailConfigSchema>;

/** Sem arquivo = sem caixa de teste. Arquivo inválido lança erro (nunca é ignorado em silêncio). */
export function loadEmailConfig(path: string): EmailConfig {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`O arquivo ${path} não é um JSON válido`);
  }
  const parsed = emailConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Configuração de e-mail inválida em ${path}: ${parsed.error.issues[0]?.message ?? 'erro'}`,
    );
  return parsed.data;
}
