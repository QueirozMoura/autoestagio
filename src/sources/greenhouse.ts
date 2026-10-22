import { z } from 'zod';
import {
  BlockedError,
  HttpStatusError,
  RateLimitedError,
  ResponseValidationError,
} from '../http/index.js';
import type { SourceTarget } from './config.js';
import { isBrazilLocation, isInternshipTitle, toIsoDate, unescapeEntities } from './filters.js';
import type { JobSource, RawJob, SourceContext, SourceRunStats } from './types.js';

/**
 * Greenhouse Job Board API. Documentação: https://docs.greenhouse.io/job-board.html
 * Leitura pública, sem autenticação: "Job Board data is publicly available, so authentication is
 * not required for any GET endpoints". Este adaptador só faz GET; nunca envia candidaturas.
 */
const API = 'https://boards-api.greenhouse.io/v1/boards';

const listSchema = z.object({ jobs: z.array(z.unknown()) });

const listedJobSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  absolute_url: z.url(),
  location: z.object({ name: z.string() }).nullish(),
});

const detailSchema = listedJobSchema.extend({
  content: z.string().nullish(),
  first_published: z.string().nullish(),
});

type ListedJob = z.infer<typeof listedJobSchema>;

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

export class GreenhouseSource implements JobSource {
  readonly kind = 'greenhouse';
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

  /**
   * Lista o quadro (uma requisição, sem descrições) e busca o detalhe somente das vagas de
   * estágio na região desejada, para não baixar centenas de descrições sem necessidade.
   */
  async *fetchJobs(ctx: SourceContext): AsyncGenerator<RawJob> {
    const stats = emptyStats();
    this.stats = stats;
    const board = `${API}/${encodeURIComponent(this.slug)}/jobs`;
    const options = { signal: ctx.signal, respectRobots: this.target.respectRobots };

    const list = await ctx.http.getJson(board, listSchema, options);
    stats.listed = list.jobs.length;

    const valid: ListedJob[] = [];
    for (const item of list.jobs) {
      const parsed = listedJobSchema.safeParse(item);
      if (parsed.success) valid.push(parsed.data);
      else stats.invalid++;
    }
    if (stats.listed > 0 && valid.length === 0) {
      throw new ResponseValidationError(board, ['nenhuma vaga no formato esperado']);
    }

    const internships = valid.filter((job) => isInternshipTitle(job.title));
    stats.internships = internships.length;
    const selected = internships.filter(
      (job) => !this.target.brazilOnly || isBrazilLocation(job.location?.name),
    );
    stats.inRegion = selected.length;

    let yielded = 0;
    for (const job of selected) {
      if (yielded >= ctx.limits.maxJobs) {
        stats.truncated = true;
        return;
      }
      const detail = await this.fetchDetail(ctx, board, job.id, options);
      if (detail === undefined) {
        stats.detailSkipped++;
        continue;
      }
      yielded++;
      yield this.toRawJob(detail);
    }
  }

  private async fetchDetail(
    ctx: SourceContext,
    board: string,
    id: number,
    options: { signal: AbortSignal | undefined; respectRobots: boolean | undefined },
  ): Promise<z.infer<typeof detailSchema> | undefined> {
    try {
      return await ctx.http.getJson(`${board}/${id}`, detailSchema, options);
    } catch (error) {
      // A vaga saiu do ar entre a listagem e o detalhe: não é falha da fonte.
      const gone =
        error instanceof HttpStatusError &&
        !(error instanceof BlockedError) &&
        !(error instanceof RateLimitedError) &&
        (error.status === 404 || error.status === 410);
      if (gone) return undefined;
      throw error;
    }
  }

  private toRawJob(job: z.infer<typeof detailSchema>): RawJob {
    const location = job.location?.name.trim();
    const postedAt = toIsoDate(job.first_published);
    return {
      externalId: String(job.id),
      url: job.absolute_url,
      title: job.title,
      company: this.name,
      ...(location ? { location } : {}),
      ...(job.content ? { description: unescapeEntities(job.content) } : {}),
      ...(postedAt ? { postedAt } : {}),
    };
  }
}
