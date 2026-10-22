import { z } from 'zod';
import { ResponseValidationError } from '../http/index.js';
import type { SourceTarget } from './config.js';
import { isBrazilLocation, isInternshipTitle, toIsoDate } from './filters.js';
import type { JobSource, RawJob, SourceContext, SourceRunStats } from './types.js';

/**
 * Ashby Public Job Posting API. Documentação: https://developers.ashbyhq.com/docs/public-job-posting-api
 * Leitura pública, sem autenticação: um único GET devolve todas as vagas publicadas do quadro
 * (sem paginação). Este adaptador só faz GET; nunca usa a API autenticada nem envia candidaturas.
 */
const API = 'https://api.ashbyhq.com/posting-api/job-board';

const listSchema = z.object({ jobs: z.array(z.unknown()) });

const addressSchema = z.object({
  addressLocality: z.string().nullish(),
  addressRegion: z.string().nullish(),
  addressCountry: z.string().nullish(),
});

const postingSchema = z.object({
  id: z.string().min(1).nullish(),
  title: z.string().min(1),
  jobUrl: z.url(),
  applyUrl: z.url().nullish(),
  location: z.string().nullish(),
  secondaryLocations: z
    .array(z.object({ location: z.string().nullish(), address: addressSchema.nullish() }))
    .nullish(),
  address: z.object({ postalAddress: addressSchema.nullish() }).nullish(),
  isListed: z.boolean().nullish(),
  isRemote: z.boolean().nullish(),
  workplaceType: z.string().nullish(),
  employmentType: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  publishedAt: z.string().nullish(),
  compensation: z
    .object({
      scrapeableCompensationSalarySummary: z.string().nullish(),
      compensationTierSummary: z.string().nullish(),
    })
    .nullish(),
});

type Posting = z.infer<typeof postingSchema>;

const WORK_MODES: Record<string, NonNullable<RawJob['workMode']>> = {
  Remote: 'remoto',
  Hybrid: 'hibrido',
  OnSite: 'presencial',
};

function emptyStats(): SourceRunStats {
  return {
    listed: 0,
    internships: 0,
    inRegion: 0,
    invalid: 0,
    detailSkipped: 0,
    truncated: false,
  };
}

/** `employmentType` quando existe; o título cobre quadros que não o preenchem (ou o preenchem mal). */
function isInternship(posting: Posting): boolean {
  return posting.employmentType === 'Intern' || isInternshipTitle(posting.title);
}

function inBrazil(posting: Posting): boolean {
  const addresses = [
    posting.address?.postalAddress,
    ...(posting.secondaryLocations ?? []).map((secondary) => secondary.address),
  ];
  return (
    addresses.some(
      (address) => address?.addressCountry != null && isBrazilLocation(address.addressCountry),
    ) ||
    isBrazilLocation(
      posting.location,
      ...(posting.secondaryLocations ?? []).map((secondary) => secondary.location),
      ...addresses.flatMap((address) => [address?.addressLocality, address?.addressRegion]),
    )
  );
}

export class AshbySource implements JobSource {
  readonly kind = 'ashby';
  readonly slug: string;
  readonly name: string;
  private stats: SourceRunStats | undefined;

  constructor(private readonly target: SourceTarget) {
    this.slug = target.slug;
    this.name = target.name;
  }

  lastRunStats(): SourceRunStats | undefined {
    return this.stats;
  }

  /** Uma requisição para o quadro inteiro; filtra estágios (e região) localmente. */
  async *fetchJobs(ctx: SourceContext): AsyncGenerator<RawJob> {
    const stats = emptyStats();
    this.stats = stats;
    const board = `${API}/${encodeURIComponent(this.slug)}?includeCompensation=true`;
    const options = { signal: ctx.signal, respectRobots: this.target.respectRobots };

    const list = await ctx.http.getJson(board, listSchema, options);
    stats.listed = list.jobs.length;

    let valid = 0;
    let yielded = 0;
    for (const item of list.jobs) {
      const parsed = postingSchema.safeParse(item);
      if (!parsed.success) {
        stats.invalid++;
        continue;
      }
      valid++;
      const posting = parsed.data;
      // Só `isListed: false` é descartado: o endpoint público devolve apenas vagas publicadas, e
      // o campo ausente não é evidência de que a vaga está oculta.
      if (posting.isListed === false) continue;
      if (!isInternship(posting)) continue;
      stats.internships++;
      if (this.target.brazilOnly && !inBrazil(posting)) continue;
      stats.inRegion++;

      if (yielded >= ctx.limits.maxJobs) {
        stats.truncated = true;
        return;
      }
      yielded++;
      yield this.toRawJob(posting);
    }

    if (stats.listed > 0 && valid === 0) {
      throw new ResponseValidationError(board, ['nenhuma vaga no formato esperado']);
    }
  }

  private toRawJob(posting: Posting): RawJob {
    const location = posting.location?.trim();
    const workMode =
      WORK_MODES[posting.workplaceType ?? ''] ?? (posting.isRemote === true ? 'remoto' : undefined);
    const description = posting.descriptionHtml?.trim() || posting.descriptionPlain?.trim();
    const compensation =
      posting.compensation?.scrapeableCompensationSalarySummary?.trim() ||
      posting.compensation?.compensationTierSummary?.trim();
    const postedAt = toIsoDate(posting.publishedAt);
    return {
      ...(posting.id ? { externalId: posting.id } : {}),
      url: posting.jobUrl,
      ...(posting.applyUrl ? { applyUrl: posting.applyUrl } : {}),
      title: posting.title,
      company: this.name,
      ...(location ? { location } : {}),
      ...(workMode ? { workMode } : {}),
      ...(description ? { description } : {}),
      ...(compensation ? { compensationText: compensation } : {}),
      ...(postedAt ? { postedAt } : {}),
    };
  }
}
