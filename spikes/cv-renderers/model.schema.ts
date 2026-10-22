/**
 * PROPOSTA (Etapa 4.0) do modelo de currículo aprovado. Não é usada pelo produto: a implementação
 * é da Etapa 4.1. Serve para validar, com dados FICTÍCIOS, que o modelo comporta o que os três
 * renderizadores precisam e o que as etapas seguintes (seleção, validadores, Gmail) vão exigir.
 *
 * Princípios:
 *  1. Todo texto visível é um BLOCO com id estável e texto EXATO aprovado. O PDF só escolhe e ordena blocos.
 *  2. Variar o texto = escolher entre VARIANTES pré-aprovadas. Nada é gerado livremente.
 *  3. Todo texto é localizável (`pt-BR` obrigatório, `en` opcional): a variante em inglês não é
 *     implementada agora, mas o modelo já a comporta.
 *  4. Cada bloco aponta para a origem no PDF mestre, para auditar a fidelidade.
 *  5. O modelo guarda dados pessoais: o arquivo real fica fora do Git (como o perfil).
 */
import { z } from 'zod';

export const LANGS = ['pt-BR', 'en'] as const;
export type Lang = (typeof LANGS)[number];

/** Texto em vários idiomas. `pt-BR` é obrigatório; os demais são opcionais até existirem. */
export const localized = z.object({ 'pt-BR': z.string().min(1), en: z.string().min(1).optional() });
export type Localized = z.infer<typeof localized>;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'id estável: minúsculas, números e hífen');
const isoDate = z.iso.date();
const yearMonth = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, 'AAAA ou AAAA-MM');

/** De onde, no PDF mestre, o texto veio. Sem isso o bloco não pode ser aprovado. */
const sourceRef = z.object({
  section: z.string().min(1),
  /** SHA-256 do trecho original normalizado: prova de fidelidade sem repetir o texto. */
  excerptSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Áreas de vaga para as quais uma variante foi pensada (as mesmas do motor de elegibilidade). */
export const AREAS = ['desenvolvimento', 'qa', 'suporte', 'infraestrutura', 'dados', 'banco-de-dados'] as const;

const variant = z.object({
  id,
  text: localized,
  /** Vazio = serve para qualquer área. */
  areas: z.array(z.enum(AREAS)).default([]),
  /** Tecnologias citadas no texto; o validador confere que estão em `skills`. */
  technologies: z.array(z.string().min(1)).default([]),
  sourceRef,
  approvedAt: isoDate,
});

/** Bloco com 1+ variantes aprovadas. A seleção escolhe UMA (ou omite o bloco, se `required` for falso). */
const variantBlock = z.object({
  id,
  required: z.boolean().default(false),
  /** Prioridade padrão (maior = mais cedo e menos provável de ser omitido ao caber em 1 página). */
  priority: z.number().int().min(0).max(100).default(50),
  variants: z.array(variant).min(1),
});

const link = z.object({
  id,
  /** Texto visível (ATS lê texto, não o destino da anotação). */
  label: z.string().min(1),
  url: z.url({ protocol: /^https?$/ }),
  /** URL extraída do PDF mestre e conferida por você. Nunca adivinhada. */
  confirmedByUser: z.boolean(),
});

const entry = z.object({
  id,
  kind: z.enum(['experiencia', 'projeto']),
  title: localized,
  organization: localized.optional(),
  period: z.object({ start: yearMonth, end: yearMonth.optional(), label: localized.optional() }),
  summary: variantBlock.optional(),
  bullets: z.array(variantBlock).default([]),
  technologies: z.array(z.string().min(1)).default([]),
  links: z.array(link).default([]),
  priority: z.number().int().min(0).max(100).default(50),
  sourceRef,
});

export const cvModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    language: z.enum(LANGS),
    /** Currículo mestre do qual o modelo foi extraído (nunca é alterado). */
    master: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), label: z.string().min(1), extractedAt: isoDate }),
    identity: z.object({
      name: z.string().min(1),
      /** Cargo/objetivo, com variantes por área (ex.: "Estágio em TI — Desenvolvedor Full Stack"). */
      headline: variantBlock,
      location: z.string().min(1),
      contacts: z
        .array(
          z.object({
            id,
            kind: z.enum(['email', 'telefone']),
            value: z.string().min(1),
          }),
        )
        .min(1),
      links: z.array(link).default([]),
    }),
    summary: variantBlock,
    experience: z.array(entry).default([]),
    projects: z.array(entry).default([]),
    education: z
      .array(
        z.object({
          id,
          course: localized,
          institution: z.string().min(1),
          degreeType: z.enum(['tecnologo', 'bacharelado', 'licenciatura', 'tecnico']).optional(),
          status: z.enum(['cursando', 'concluido']),
          /** Texto exato aprovado, ex.: "Cursando, previsão de conclusão em 2028". */
          statusLabel: localized,
          sourceRef,
        }),
      )
      .min(1),
    skills: z
      .array(
        z.object({
          id,
          category: localized,
          items: z.array(z.string().min(1)).min(1),
          priority: z.number().int().min(0).max(100).default(50),
          /** Em quais áreas esta categoria sobe para o início. */
          areas: z.array(z.enum(AREAS)).default([]),
          sourceRef,
        }),
      )
      .min(1),
    languages: z.array(z.object({ id, label: localized, sourceRef })).default([]),
    certifications: z
      .array(z.object({ id, title: localized, issuer: z.string().min(1), year: z.number().int().min(1990).max(2100), sourceRef }))
      .default([]),
    /** Preferências de layout independentes do renderizador. */
    layout: z
      .object({
        sectionOrder: z
          .array(z.enum(['summary', 'experience', 'projects', 'skills', 'education', 'languages', 'certifications']))
          .default(['summary', 'experience', 'projects', 'skills', 'education', 'languages', 'certifications']),
        maxPages: z.number().int().min(1).max(2).default(1),
      })
      .default({ sectionOrder: ['summary', 'experience', 'projects', 'skills', 'education', 'languages', 'certifications'], maxPages: 1 }),
  })
  .superRefine((model, ctx) => {
    // Ids únicos em todo o modelo: a seleção e os validadores referenciam blocos por id.
    const seen = new Set<string>();
    const add = (value: string, path: (string | number)[]): void => {
      if (seen.has(value)) ctx.addIssue({ code: 'custom', path, message: `id repetido: ${value}` });
      seen.add(value);
    };
    const walkBlock = (block: { id: string; variants: { id: string }[] }, path: (string | number)[]): void => {
      add(block.id, [...path, 'id']);
      block.variants.forEach((v, i) => add(v.id, [...path, 'variants', i, 'id']));
    };
    walkBlock(model.identity.headline, ['identity', 'headline']);
    walkBlock(model.summary, ['summary']);
    for (const [key, list] of [['experience', model.experience], ['projects', model.projects]] as const) {
      list.forEach((e, i) => {
        add(e.id, [key, i, 'id']);
        if (e.summary) walkBlock(e.summary, [key, i, 'summary']);
        e.bullets.forEach((b, j) => walkBlock(b, [key, i, 'bullets', j]));
      });
    }
    model.skills.forEach((s, i) => add(s.id, ['skills', i, 'id']));
    model.education.forEach((e, i) => add(e.id, ['education', i, 'id']));

    // Variante em inglês só é exigida quando o documento for gerado em inglês (futuro).
    if (model.language === 'en') {
      const texts: { path: (string | number)[]; text: Localized }[] = [];
      model.summary.variants.forEach((v, i) => texts.push({ path: ['summary', 'variants', i], text: v.text }));
      for (const t of texts) {
        if (t.text.en === undefined) ctx.addIssue({ code: 'custom', path: [...t.path, 'text', 'en'], message: 'falta a versão em inglês' });
      }
    }
  });

export type CvModel = z.infer<typeof cvModelSchema>;
