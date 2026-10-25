import { z } from 'zod';
import { isInternshipTitle } from './filters.js';
import { rawJobSchema, type RawJob } from './types.js';

/**
 * Contrato PROVISÓRIO para amostras locais da Sólides. Não é uma API oficial.
 * Recebe somente dados em memória; não importa HTTP, não pagina e não é registrado no scan.
 * Os nomes/códigos deverão ser conferidos com amostras autorizadas antes de uma integração real.
 */
const vacancySchema = z.object({
  id: z.union([z.string().min(1), z.number().int().positive()]),
  title: z.string().min(1),
  company: z.string().min(1).optional(),
  description: z.string().optional(),
  location: z.string().min(1).optional(),
  jobType: z.string().optional(),
  homeOffice: z.boolean().optional(),
  salary: z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() }).optional(),
  affirmative: z.string().min(1).optional(),
  pcdOnly: z.boolean().optional(),
});
const pageSchema = z.object({
  count: z.number().int().nonnegative(),
  currentPage: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
  data: z.array(z.unknown()),
});

export function parseSolidesSample(input: unknown): {
  jobs: RawJob[];
  invalid: number;
  filtered: number;
  /** Paginação é informativa: nunca dispara outra requisição. */
  hasMore: boolean;
} {
  const page = pageSchema.parse(input);
  const jobs: RawJob[] = [];
  let invalid = 0;
  let filtered = 0;
  for (const item of page.data) {
    const parsed = vacancySchema.safeParse(item);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const vacancy = parsed.data;
    if (!isInternshipTitle(vacancy.title)) {
      filtered++;
      continue;
    }
    const explicitMode: Record<string, RawJob['workMode']> = {
      presencial: 'presencial',
      hibrido: 'hibrido',
      remoto: 'remoto',
    };
    const declared = explicitMode[vacancy.jobType ?? ''];
    // Sinais contraditórios ficam desconhecidos; false sozinho não comprova presencial.
    const conflict = vacancy.homeOffice === true && declared !== undefined && declared !== 'remoto';
    const workMode = conflict
      ? undefined
      : (declared ?? (vacancy.homeOffice === true ? 'remoto' : undefined));
    const salary = vacancy.salary;
    const money = (value: number): string =>
      value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const compensationText =
      salary === undefined || salary.max === 0 || salary.max < salary.min
        ? undefined
        : salary.min === 0
          ? `Até ${money(salary.max)} (mínimo não informado)`
          : `${money(salary.min)} a ${money(salary.max)}`;
    const description = [
      vacancy.description,
      vacancy.affirmative ? `Vaga afirmativa: ${vacancy.affirmative}` : undefined,
      vacancy.pcdOnly === true ? 'Vaga exclusiva para pessoas com deficiência (PCD).' : undefined,
    ]
      .filter(Boolean)
      .join('\n');
    jobs.push(
      rawJobSchema.parse({
        externalId: String(vacancy.id),
        url: `https://vagas.solides.com.br/vaga/${encodeURIComponent(String(vacancy.id))}`,
        title: vacancy.title,
        ...(vacancy.company ? { company: vacancy.company } : {}),
        ...(vacancy.location ? { location: vacancy.location } : {}),
        ...(description ? { description } : {}),
        ...(workMode ? { workMode } : {}),
        ...(compensationText ? { compensationText } : {}),
      }),
    );
  }
  return { jobs, invalid, filtered, hasMore: page.currentPage < page.totalPages };
}
