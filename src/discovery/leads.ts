import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { evaluateJob, type Criterion } from '../eligibility/index.js';
import { parseStipend } from './stipend.js';
import { collapseWhitespace, toKey } from './text.js';

/**
 * Leads de alertas (Indeed, LinkedIn...): pistas, NÃO vagas oficiais, NÃO candidaturas. Não há ligação com envio de
 * e-mail: um lead não autoriza nada e o canal de candidatura só muda por decisão sua, depois de conferir a página
 * oficial. Esta camada só guarda, deduplica e AVALIA (título, local e bolsa) para ajudar a priorizar a conferência.
 */
export const LEAD_SOURCES = ['indeed', 'linkedin', 'gupy', 'outro'] as const;
export const LEAD_CHANNELS = ['desconhecido', 'formulario', 'portal_empresa'] as const;
export const LEAD_STATUSES = ['nova', 'em_analise', 'descartada', 'aplicada_manualmente'] as const;
export const WORK_MODES = ['remoto', 'hibrido', 'presencial'] as const;

export const leadInputSchema = z.strictObject({
  source: z.enum(LEAD_SOURCES),
  title: z.string().min(1).max(200),
  company: z.string().min(1).max(200).optional(),
  location: z.string().min(1).max(200).optional(),
  workMode: z.enum(WORK_MODES).optional(),
  stipendText: z.string().min(1).max(120).optional(),
  url: z.string().max(500).optional(),
  receivedOn: z.iso.date().optional(),
  note: z.string().max(300).optional(),
});
export type LeadInput = z.infer<typeof leadInputSchema>;

export class LeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeadError';
  }
}

export const leadKey = (
  title: string,
  company: string | undefined,
  location: string | undefined,
): string =>
  createHash('sha256')
    .update([title, company ?? '', location ?? ''].map(toKey).join('|'))
    .digest('hex')
    .slice(0, 32);

/** Só HTTPS, sem query nem fragmento (links de alerta carregam identificadores pessoais). */
export function sanitizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LeadError('URL inválida.');
  }
  if (url.protocol !== 'https:') throw new LeadError('A URL do lead precisa ser HTTPS.');
  return `${url.origin}${url.pathname}`;
}

export interface LeadRow {
  id: number;
  source: (typeof LEAD_SOURCES)[number];
  title: string;
  company: string | null;
  location: string | null;
  work_mode: (typeof WORK_MODES)[number] | null;
  stipend_text: string | null;
  url: string | null;
  received_on: string | null;
  channel: (typeof LEAD_CHANNELS)[number];
  status: (typeof LEAD_STATUSES)[number];
  note: string | null;
  created_at: string;
}

export function addLead(
  db: Db,
  raw: unknown,
  now: Date = new Date(),
): { id: number; created: boolean } {
  const parsed = leadInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new LeadError(`Lead inválido: ${parsed.error.issues[0]?.message ?? 'erro'}.`);
  const input = parsed.data;
  // Sem caracteres de controle (um alerta colado não pode injetar sequências de terminal), com espaços compactados.
  const clean = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    // eslint-disable-next-line no-control-regex
    const text = collapseWhitespace(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' '));
    return text === '' ? undefined : text;
  };
  const title = clean(input.title);
  if (title === undefined) throw new LeadError('Lead inválido: título vazio.');
  const company = clean(input.company);
  const location = clean(input.location);
  const key = leadKey(title, company, location);
  const existing = db
    .prepare('SELECT id FROM job_leads WHERE source = ? AND lead_key = ?')
    .get(input.source, key) as { id: number } | undefined;
  if (existing !== undefined) return { id: existing.id, created: false };
  const at = now.toISOString();
  const result = db
    .prepare(
      `INSERT INTO job_leads (source, title, company, location, work_mode, stipend_text, url, lead_key, received_on, note, created_at, updated_at)
       VALUES (@source, @title, @company, @location, @mode, @stipend, @url, @key, @received, @note, @at, @at)`,
    )
    .run({
      source: input.source,
      title,
      company: company ?? null,
      location: location ?? null,
      mode: input.workMode ?? null,
      stipend: clean(input.stipendText) ?? null,
      url: input.url === undefined ? null : sanitizeUrl(input.url),
      key,
      received: input.receivedOn ?? null,
      note: clean(input.note) ?? null,
      at,
    });
  return { id: Number(result.lastInsertRowid), created: true };
}

export function importLeads(
  db: Db,
  items: readonly unknown[],
  now: Date = new Date(),
): { created: number; duplicates: number } {
  let created = 0;
  let duplicates = 0;
  db.transaction(() => {
    for (const item of items) {
      if (addLead(db, item, now).created) created++;
      else duplicates++;
    }
  })();
  return { created, duplicates };
}

export function listLeads(db: Db, filter: { status?: LeadRow['status'] } = {}): LeadRow[] {
  return (
    filter.status === undefined
      ? db.prepare('SELECT * FROM job_leads ORDER BY id').all()
      : db.prepare('SELECT * FROM job_leads WHERE status = ? ORDER BY id').all(filter.status)
  ) as LeadRow[];
}

export function updateLead(
  db: Db,
  id: number,
  change: { status?: LeadRow['status']; channel?: LeadRow['channel']; note?: string },
  now: Date = new Date(),
): void {
  if (change.status !== undefined && !(LEAD_STATUSES as readonly string[]).includes(change.status))
    throw new LeadError('Estado inválido.');
  if (
    change.channel !== undefined &&
    !(LEAD_CHANNELS as readonly string[]).includes(change.channel)
  )
    throw new LeadError('Canal inválido.');
  if (change.note !== undefined && change.note.length > 300)
    throw new LeadError('A nota aceita até 300 caracteres.');
  const row = db.prepare('SELECT id FROM job_leads WHERE id = ?').get(id);
  if (row === undefined) throw new LeadError(`Lead ${id} não encontrado.`);
  db.prepare(
    'UPDATE job_leads SET status = COALESCE(@status, status), channel = COALESCE(@channel, channel), note = COALESCE(@note, note), updated_at = @at WHERE id = @id',
  ).run({
    id,
    status: change.status ?? null,
    channel: change.channel ?? null,
    note: change.note ?? null,
    at: now.toISOString(),
  });
}

export interface LeadAssessment {
  /** Nunca "apto": um lead não tem descrição completa nem canal oficial confirmado. */
  verdict: 'inapto' | 'revisao_humana';
  area: Criterion['outcome'];
  location: Criterion['outcome'];
  stipend: Criterion['outcome'];
  reasons: string[];
}

/**
 * Avalia só o que o alerta traz (título, local, modalidade, bolsa) com as MESMAS regras de elegibilidade. Sem a
 * descrição da vaga não há requisitos a conferir, então o melhor resultado possível é "revisão humana".
 */
export function assessLead(
  profile: Profile,
  lead: LeadRow,
  now: Date = new Date(),
): LeadAssessment {
  const stipend = lead.stipend_text === null ? null : parseStipend(lead.stipend_text);
  const result = evaluateJob(
    profile,
    {
      title: lead.title,
      company: lead.company,
      location: lead.location,
      workMode: lead.work_mode,
      description: null,
      stipendMin: stipend?.min ?? null,
      stipendMax: stipend?.max ?? null,
      stipendCurrency: stipend?.currency ?? null,
      stipendText: lead.stipend_text,
    },
    { now },
  );
  const outcome = (id: string): Criterion['outcome'] =>
    result.criteria.find((c) => c.id === id)?.outcome ?? 'indeterminado';
  const placeOutcomes = ['modalidade', 'localizacao', 'deslocamento']
    .map((id) => result.criteria.find((c) => c.id === id)?.outcome)
    .filter((o): o is Criterion['outcome'] => o !== undefined);
  const locationOutcome: Criterion['outcome'] = placeOutcomes.includes('nao_atende')
    ? 'nao_atende'
    : placeOutcomes.includes('indeterminado') || placeOutcomes.length === 0
      ? 'indeterminado'
      : 'atende';
  return {
    verdict: result.verdict === 'inapto' ? 'inapto' : 'revisao_humana',
    area: outcome('area'),
    location: locationOutcome,
    stipend: outcome('bolsa'),
    reasons: [
      ...(result.verdict === 'inapto' ? result.reasons : []),
      'Lead de alerta: confirme na página oficial os requisitos, a validade e o canal de candidatura (e-mail nunca é presumido).',
    ],
  };
}
