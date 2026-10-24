import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Profile } from '../config/index.js';
import { profileSchema } from '../config/profile.js';
import type { Db } from '../db/index.js';
import { GREATER_SP, OTHER_CITIES, commuteMatches, placeLabel } from './evaluate.js';
import { norm } from './areas.js';

/**
 * Locais de vagas presenciais/híbridas cujo deslocamento ainda não tem tempo CONFIRMADO por você. Nada é
 * estimado: a lista serve para você conferir cada local uma vez (ex.: Google Maps, transporte público) e registrar.
 */
export interface PendingLocation {
  location: string;
  jobs: number;
  region: 'sao-paulo' | 'metropolitana' | 'indefinida';
}

export function pendingLocations(db: Db, profile: Profile): PendingLocation[] {
  const rows = db
    .prepare(
      "SELECT company, location, description FROM jobs WHERE work_mode IN ('hibrido', 'presencial') AND location IS NOT NULL AND trim(location) <> ''",
    )
    .all() as { company: string | null; location: string; description: string | null }[];
  const city = norm(profile.city).split(',')[0]?.trim() ?? '';
  const byLocation = new Map<string, PendingLocation>();
  for (const row of rows) {
    const location = norm(row.location);
    if (OTHER_CITIES.test(location)) continue;
    if (
      commuteMatches(
        {
          title: '',
          company: row.company,
          location: row.location,
          description: row.description,
          workMode: 'presencial',
          stipendMin: null,
          stipendMax: null,
          stipendCurrency: null,
        },
        profile,
      ).length > 0
    )
      continue;
    const region: PendingLocation['region'] =
      city !== '' && location.includes(city)
        ? 'sao-paulo'
        : GREATER_SP.test(location)
          ? 'metropolitana'
          : 'indefinida';
    const label = placeLabel({
      title: '',
      company: row.company,
      location: row.location,
      description: row.description,
      workMode: 'presencial',
      stipendMin: null,
      stipendMax: null,
      stipendCurrency: null,
    }).trim();
    const current = byLocation.get(label);
    if (current === undefined) byLocation.set(label, { location: label, jobs: 1, region });
    else current.jobs++;
  }
  return [...byLocation.values()].sort(
    (a, b) => b.jobs - a.jobs || a.location.localeCompare(b.location),
  );
}

export interface CommuteEntryInput {
  keywords: string[];
  minutesPerWay: number;
  source: string;
  confirmedAt?: string | undefined;
}

export class CommuteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommuteError';
  }
}

/**
 * Registra (ou substitui, se as palavras forem as mesmas) um tempo de deslocamento confirmado por você no
 * arquivo do perfil. Valida o perfil inteiro antes de gravar, faz cópia de segurança (uma vez) e grava de forma
 * atômica, mantendo as permissões do arquivo. Nunca inventa dados: tudo vem dos argumentos.
 */
export function registerCommute(
  profilePath: string,
  input: CommuteEntryInput,
  now: Date = new Date(),
): { replaced: boolean } {
  const keywords = [...new Set(input.keywords.map((k) => norm(k).trim()).filter((k) => k !== ''))];
  if (keywords.length === 0)
    throw new CommuteError('Informe ao menos uma palavra que identifique o local.');
  if (
    !Number.isInteger(input.minutesPerWay) ||
    input.minutesPerWay <= 0 ||
    input.minutesPerWay > 600
  )
    throw new CommuteError('Informe os minutos por trecho (inteiro entre 1 e 600).');
  const source = input.source.trim();
  if (source === '')
    throw new CommuteError(
      'Informe como o tempo foi verificado (ex.: "Google Maps, transporte público").',
    );
  const confirmedAt = input.confirmedAt ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(confirmedAt))
    throw new CommuteError('Data inválida (use AAAA-MM-DD).');
  if (!existsSync(profilePath)) throw new CommuteError('Perfil não encontrado.');

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new CommuteError('O perfil não é um JSON válido; nada foi alterado.');
  }
  const current = Array.isArray(raw.commute) ? (raw.commute as { keywords?: string[] }[]) : [];
  const same = (entry: { keywords?: string[] }): boolean =>
    [...(entry.keywords ?? [])].sort().join('|') === [...keywords].sort().join('|');
  const replaced = current.some(same);
  const entry = { keywords, minutesPerWay: input.minutesPerWay, source, confirmedAt };
  const next = { ...raw, commute: [...current.filter((e) => !same(e)), entry] };
  const parsed = profileSchema.safeParse(next);
  if (!parsed.success)
    throw new CommuteError('O perfil ficaria inválido com esta entrada; nada foi alterado.');

  const mode = statSync(profilePath).mode & 0o777;
  const backup = `${profilePath}.pre-locais.bak`;
  if (!existsSync(backup)) {
    copyFileSync(profilePath, backup);
    chmodSync(backup, 0o600);
  }
  const temp = `${profilePath}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, profilePath);
  return { replaced };
}
