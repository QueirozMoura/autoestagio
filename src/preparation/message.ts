import { createHash } from 'node:crypto';
import type { LanguageLevel, Profile } from '../config/index.js';
import { technologiesIn } from '../eligibility/requirements.js';

/** Muda quando o texto ou as regras de geração mudam: rascunhos antigos ficam "desatualizados". */
export const GENERATOR_VERSION = '2';

export interface DraftJob {
  title: string;
  company: string | null;
  description: string | null;
}

export interface Fact {
  /** O que a mensagem afirma. */
  claim: string;
  /** Campo de origem: `perfil.*` (aprovado) ou `vaga.*` (publicado pela empresa). */
  source: string;
}

export interface GeneratedDraft {
  subject: string;
  body: string;
  language: 'pt-BR';
  facts: Fact[];
}

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
const DEGREE: Record<string, string> = {
  tecnologo: 'tecnólogo',
  bacharelado: 'bacharelado',
  licenciatura: 'licenciatura',
};
const LEVEL: Record<LanguageLevel, string> = {
  nenhum: 'nenhum',
  basico: 'básico',
  intermediario: 'intermediário',
  avancado: 'avançado',
  fluente: 'fluente',
};

/** Texto vindo da vaga é dado não confiável: vira uma linha simples, sem links, e-mails nem marcação. */
export function cleanInline(value: string, max = 120): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\S+@\S+/g, '')
      .replace(/\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}/g, '')
      .replace(/[@<>`*_#|[\]{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

function date(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Gera a mensagem de candidatura. Determinística e feita só de modelos de texto: usa apenas o que
 * está no perfil aprovado e o que a vaga publicou. Não inventa experiências, habilidades,
 * certificações, resultados nem níveis de idioma. Cada afirmação sai com a sua origem em `facts`.
 */
export function generateDraft(input: {
  profile: Profile;
  job: DraftJob;
  /** Identificação do currículo da candidatura. NÃO entra no texto: o anexo efetivo pode ser outro (vínculo). */
  cvLabel: string;
  now: Date;
}): GeneratedDraft {
  const { profile, job, now } = input;
  const facts: Fact[] = [];
  const title = cleanInline(job.title) || 'vaga de estágio';
  const company = job.company === null ? '' : cleanInline(job.company, 80);
  const jobText = `${job.title}\n${job.description ?? ''}`;

  const paragraphs: string[] = [];
  paragraphs.push(company === '' ? 'Olá,' : `Olá, equipe ${company},`);

  paragraphs.push(`Meu nome é ${profile.name} e tenho interesse na vaga de ${title}.`);
  facts.push({ claim: `nome: ${profile.name}`, source: 'perfil.name' });
  facts.push({ claim: `vaga: ${title}`, source: 'vaga.title' });
  if (company !== '') facts.push({ claim: `empresa: ${company}`, source: 'vaga.company' });

  const { education } = profile;
  const degree =
    education.degreeType === undefined ? '' : ` (${DEGREE[education.degreeType] ?? ''})`;
  const parts = [`Estou cursando ${education.course}${degree} na ${education.institution}`];
  if (education.currentSemester !== undefined) {
    parts.push(`atualmente no ${education.currentSemester}º semestre`);
  }
  const month = education.expectedGraduationMonth;
  parts.push(
    `com previsão de conclusão em ${month === undefined ? '' : `${MONTHS[month - 1]} de `}${education.expectedGraduationYear}`,
  );
  paragraphs.push(`${parts.join(', ')}.`);
  facts.push({
    claim: `curso: ${education.course}, ${education.institution}`,
    source: 'perfil.education',
  });

  // Tecnologias: só as que o perfil aprovado tem E que a vaga cita.
  const have = new Set<string>();
  for (const technology of profile.technologies) {
    for (const name of technologiesIn(technology)) have.add(name);
  }
  const wanted = [...technologiesIn(jobText)].filter((name) => have.has(name)).slice(0, 6);
  if (wanted.length > 0) {
    paragraphs.push(
      `Entre as tecnologias que utilizo e que aparecem na descrição da vaga: ${wanted.join(', ')}.`,
    );
    facts.push({
      claim: `tecnologias em comum: ${wanted.join(', ')}`,
      source: 'perfil.technologies ∩ vaga.description',
    });
  }

  // Destaques confirmados pelo usuário (texto exato), os mais ligados à vaga primeiro.
  const highlights = [...(profile.highlights ?? [])]
    .map((highlight, index) => ({
      highlight,
      index,
      score: highlight.technologies.filter((name) =>
        [...technologiesIn(name)].some((canonical) => wanted.includes(canonical)),
      ).length,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2);
  if (highlights.length > 0) {
    paragraphs.push(
      `Alguns projetos que posso destacar:\n${highlights.map(({ highlight }) => `- ${highlight.title}: ${highlight.summary}`).join('\n')}`,
    );
    for (const { highlight, index } of highlights) {
      facts.push({ claim: `projeto: ${highlight.title}`, source: `perfil.highlights[${index}]` });
    }
  }

  // Inglês: só se a vaga o menciona, e com o escopo exato que o perfil comprova.
  if (/\b(?:ingles|inglês|english)\b/i.test(jobText.normalize('NFD').replace(/\p{M}/gu, ''))) {
    const english = profile.languages?.find((entry) =>
      /^(?:ingles|english)$/i.test(entry.language.normalize('NFD').replace(/\p{M}/gu, '')),
    );
    if (english !== undefined) {
      const scope =
        english.scope === 'leitura-tecnica' ? ' para leitura técnica e documentação' : '';
      paragraphs.push(`Sobre o idioma, tenho inglês ${LEVEL[english.level]}${scope}.`);
      facts.push({
        claim: `inglês ${LEVEL[english.level]} (${english.scope})`,
        source: 'perfil.languages',
      });
    }
  }

  const availability = profile.availability;
  if (availability !== undefined) {
    const { min, max } = availability.hoursPerWeek;
    const hours = min === max ? `${min} horas semanais` : `de ${min} a ${max} horas semanais`;
    const start =
      new Date(`${availability.startFrom}T00:00:00Z`) <= now
        ? 'início imediato'
        : `início a partir de ${date(availability.startFrom)}`;
    paragraphs.push(`Tenho disponibilidade ${hours}, com ${start}.`);
    facts.push({ claim: `disponibilidade: ${hours}; ${start}`, source: 'perfil.availability' });
  }

  paragraphs.push(
    'Segue meu currículo em anexo. Fico à disposição para conversar sobre a oportunidade.',
  );
  paragraphs.push(`Atenciosamente,\n${profile.name}`);

  return {
    subject: `Candidatura - ${title} - ${profile.name}`,
    body: paragraphs.join('\n\n'),
    language: 'pt-BR',
    facts,
  };
}

export function contentHash(
  draft: Pick<GeneratedDraft, 'subject' | 'body'>,
  inputs: {
    profileHash: string;
    jobContentHash: string;
    cvSha256: string;
  },
): string {
  return createHash('sha256')
    .update(JSON.stringify([GENERATOR_VERSION, draft.subject, draft.body, inputs]))
    .digest('hex');
}
