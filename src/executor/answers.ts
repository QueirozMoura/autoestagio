import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { PROJECT_ROOT } from '../utils/paths.js';

/**
 * Respostas que VOCÊ confirmou para uma candidatura específica (config/answers.json, fora do Git). Cada resposta vale só
 * para o item da fila indicado e para a pergunta indicada: nunca é reaproveitada em outra vaga, e o executor não
 * responde nada que não esteja aqui, no perfil ou nos dados do candidato.
 */
const entry = z.strictObject({
  /** Trecho da pergunta (sem acentos/maiúsculas): basta aparecer no rótulo do campo. */
  question: z.string().min(8),
  /** Texto exato da opção (ou do valor) a responder. */
  answer: z.string().min(1),
  /** Quando e onde você confirmou (auditoria). */
  confirmedAt: z.string().min(8),
});

export const answersSchema = z.strictObject({
  /** Chave: id do item da fila. */
  queue: z.record(z.string().regex(/^\d+$/), z.array(entry)).default({}),
});
export type ConfirmedAnswer = z.infer<typeof entry> & { source: string };

export const DEFAULT_ANSWERS_PATH = `${PROJECT_ROOT}/config/answers.json`;

export function loadAnswers(
  queueId: number,
  path: string = DEFAULT_ANSWERS_PATH,
): ConfirmedAnswer[] {
  if (!existsSync(path)) return [];
  const parsed = answersSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!parsed.success) throw new Error('config/answers.json inválido.');
  return (parsed.data.queue[String(queueId)] ?? []).map((a) => ({
    ...a,
    source: `resposta confirmada por você em ${a.confirmedAt}`,
  }));
}
