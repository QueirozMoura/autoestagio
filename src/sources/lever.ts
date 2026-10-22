import { z } from 'zod';
import { ResponseValidationError } from '../http/index.js';
import type { SourceTarget } from './config.js';
import { isBrazilLocation, isInternshipTitle, toIsoDate } from './filters.js';
import type { JobSource, RawJob, SourceContext, SourceRunStats } from './types.js';

/**
 * Lever Postings API. Documentação: https://github.com/lever/postings-api
 * Vagas no estado "published" são públicas. Este adaptador só faz GET na listagem; nunca usa o
 * endpoint de candidatura (POST com chave de API).
 */
const HOSTS = { global: 'https://api.lever.co', eu: 'https://api.eu.lever.co' } as const;
const PAGE_SIZE = 100;

const postingSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  hostedUrl: z.url(),
  country: z.string().nullish(),
  workplaceType: z.string().nullish(),
  categories: z
    .object({
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  description: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additional: z.string().nullish(),
  createdAt: z.number().nullish(),
});

type Posting = z.infer<typeof postingSchema>;

const WORK_MODES: Record<string, NonNullable<RawJob['workMode']>> = {
  remote: 'remoto',
  hybrid: 'hibrido',
  'on-site': 'presencial',
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

function inBrazil(posting: Posting): boolean {
  return (
    posting.country === 'BR' ||
    isBrazilLocation(posting.categories?.location, ...(posting.categories?.allLocations ?? []))
  );
}

function descriptionOf(posting: Posting): string | undefined {
  const parts = [
    posting.description,
    ...(posting.lists ?? []).map((list) =>
      list.content ? `<h3>${list.text ?? ''}</h3><ul>${list.content}</ul>` : undefined,
    ),
    posting.additional,
  ].filter((part): part is string => typeof part === 'string' && part !== '');
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export class LeverSource implements JobSource {
  readonly kind = 'lever';
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

  /** A listagem já traz as descrições; pagina com `limit`/`skip` até o fim ou até os limites. */
  async *fetchJobs(ctx: SourceContext): AsyncGenerator<RawJob> {
    const stats = emptyStats();
    this.stats = stats;
    const base = `${HOSTS[this.target.instance]}/v0/postings/${encodeURIComponent(this.slug)}`;
    const options = { signal: ctx.signal, respectRobots: this.target.respectRobots };

    let yielded = 0;
    let validTotal = 0;
    for (let page = 0; ; page++) {
      if (page >= ctx.limits.maxPages) {
        stats.truncated = true;
        break;
      }
      const url = `${base}?mode=json&limit=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`;
      const items = await ctx.http.getJson(url, z.array(z.unknown()), options);
      stats.listed += items.length;

      for (const item of items) {
        const parsed = postingSchema.safeParse(item);
        if (!parsed.success) {
          stats.invalid++;
          continue;
        }
        validTotal++;
        const posting = parsed.data;
        if (!isInternshipTitle(posting.text)) continue;
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

      if (items.length < PAGE_SIZE) break;
    }

    if (stats.listed > 0 && validTotal === 0) {
      throw new ResponseValidationError(base, ['nenhuma vaga no formato esperado']);
    }
  }

  private toRawJob(posting: Posting): RawJob {
    const location = posting.categories?.location?.trim();
    const workMode = WORK_MODES[posting.workplaceType ?? ''];
    const description = descriptionOf(posting);
    const postedAt = toIsoDate(posting.createdAt);
    return {
      externalId: posting.id,
      url: posting.hostedUrl,
      title: posting.text,
      company: this.name,
      ...(location ? { location } : {}),
      ...(workMode ? { workMode } : {}),
      ...(description ? { description } : {}),
      ...(postedAt ? { postedAt } : {}),
    };
  }
}
