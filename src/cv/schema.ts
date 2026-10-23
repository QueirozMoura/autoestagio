import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AREAS } from '../eligibility/areas.js';

/**
 * Modelo MESTRE do currículo: o conteúdo do PDF original, estruturado e rastreável.
 *
 * Regras que o esquema impõe:
 *  1. Todo texto do modelo veio do PDF mestre (`origin: 'mestre'`) e carrega a origem (`sourceRef`).
 *     Textos revisados por você entram como variantes `origin: 'editada'`: derivam de uma variante
 *     do mestre (`derivedFrom`), carregam o motivo (`basis`: declaração sua ou evidência técnica) e
 *     NÃO entram na conferência de fidelidade com o PDF (o PDF só confere o que é do PDF).
 *  2. Nada nasce aprovado: `status` começa em `rascunho` e só vira `aprovado` com `approvedAt`
 *     (a aprovação é um ato seu, registrado depois; esta etapa nunca a preenche).
 *  3. Variantes e destaques propostos ficam em `proposals`, fora das seções do currículo, com
 *     `status: 'proposta'`, até você aprová-los.
 *  4. O arquivo real do modelo contém dados pessoais e fica fora do Git.
 */
export const SECTIONS = [
  'cabecalho',
  'resumo',
  'experiencia',
  'projetos',
  'skills',
  'educacao',
  'idiomas',
  'certificacoes',
] as const;
export type SectionId = (typeof SECTIONS)[number];

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, '64 caracteres hexadecimais minúsculos');
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{1,90}$/, 'id estável: minúsculas, números e hífen');
const isoDate = z.iso.date();

/** De onde, no PDF mestre, o texto veio. */
export const sourceRefSchema = z.object({
  section: z.enum(SECTIONS),
  page: z.number().int().min(1),
  /** Linhas (1-based, na extração do PDF) que compõem o texto. */
  lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  /** SHA-256 do texto normalizado: prova a ligação sem depender de reler o PDF. */
  textSha256: sha256Hex,
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

const approvalShape = {
  /** Só `aprovado` (com `approvedAt`) vale. `rascunho` e `rejeitado` nunca entram em um currículo. */
  status: z.enum(['rascunho', 'aprovado', 'rejeitado']).default('rascunho'),
  approvedAt: isoDate.optional(),
};
const approvalConsistent = (value: { status: string; approvedAt?: string | undefined }): boolean =>
  (value.status === 'aprovado') === (value.approvedAt !== undefined);
const approvalMessage = {
  message: 'status "aprovado" exige approvedAt, e approvedAt só existe quando aprovado',
};

const fact = z.object({ value: z.string().min(1), sourceRef: sourceRefSchema });

/**
 * Rastreabilidade de uma alteração ou confirmação: declarações suas e evidências técnicas ficam
 * SEPARADAS (`kind`), para nunca passar uma declaração por evidência verificada.
 */
export const BASIS_KINDS = [
  'declaracao_proprietario',
  'decisao_proprietario',
  'evidencia_codigo',
  'evidencia_execucao',
  'evidencia_publica',
  'evidencia_documental',
] as const;
export const basisSchema = z.object({
  kind: z.enum(BASIS_KINDS),
  ref: z.string().min(1),
  note: z.string().min(1),
});
export type Basis = z.infer<typeof basisSchema>;

/** Carimbo de um texto curado por você: quando e por quê. */
const curatedStamp = { approvedAt: isoDate, basis: z.array(basisSchema).min(1) };

const variantSchema = z
  .object({
    id,
    text: z.string().min(1),
    areas: z.array(z.enum(AREAS)).default([]),
    technologies: z.array(z.string().min(1)).default([]),
    origin: z.enum(['mestre', 'editada']),
    /** Variante do mestre de onde a editada deriva (obrigatório se, e só se, `origin: 'editada'`). */
    derivedFrom: id.optional(),
    /** Por que o texto mudou (obrigatório nas editadas). */
    basis: z.array(basisSchema).default([]),
    /** Origem no PDF: nas editadas, a do texto de onde derivam. */
    sourceRef: sourceRefSchema,
    ...approvalShape,
  })
  .refine(approvalConsistent, approvalMessage)
  .refine((v) => (v.origin === 'editada') === (v.derivedFrom !== undefined), {
    message: 'derivedFrom existe se, e somente se, a variante é "editada"',
  })
  .refine((v) => v.origin !== 'editada' || v.basis.length > 0, {
    message: 'variante editada exige ao menos uma base (declaração ou evidência)',
  });

/**
 * Bloco com 1+ variantes. O PDF original dá a variante `mestre` de cada bloco; as `editada`s
 * (textos revisados, variantes por área) convivem com ela, e só as aprovadas valem.
 */
const variantBlockSchema = z.object({
  id,
  required: z.boolean().default(false),
  priority: z.number().int().min(0).max(100).default(50),
  variants: z.array(variantSchema).min(1),
});

const linkSchema = z
  .object({
    id,
    label: z.string().min(1),
    url: z.url({ protocol: /^https?$/ }),
    /** Onde o link está no PDF mestre (anotação). */
    page: z.number().int().min(1),
    /** Estar no PDF NÃO aprova o link: só você marca `confirmedByUser`, depois de conferi-lo. */
    confirmedByUser: z.boolean().default(false),
    ...approvalShape,
  })
  .refine(approvalConsistent, approvalMessage);

const entrySchema = z.object({
  id,
  kind: z.enum(['experiencia', 'projeto']),
  /** Linha de título exatamente como no PDF (sem o período). */
  title: z.string().min(1),
  /** Partes do título (subtrechos exatos de `title`, separados por " — "). */
  organization: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  /** Ausente quando o PDF não informa período para a entrada. */
  period: z
    .object({
      label: z.string().min(1),
      start: z.string().optional(),
      end: z.string().optional(),
    })
    .optional(),
  bullets: z.array(variantBlockSchema).default([]),
  technologies: z.array(z.string().min(1)).default([]),
  links: z.array(linkSchema).default([]),
  /** Título/tecnologias revisados por você (o título e as tecnologias do PDF ficam intactos acima). */
  curated: z
    .object({
      title: z.string().min(1).optional(),
      technologies: z.array(z.string().min(1)).min(1).optional(),
      ...curatedStamp,
    })
    .refine((c) => c.title !== undefined || c.technologies !== undefined, {
      message: 'curated sem título nem tecnologias',
    })
    .optional(),
  sourceRef: sourceRefSchema,
});

const claimKinds = [
  'numero_usuarios',
  'numero_testes',
  'producao_comercial',
  'tecnica_especifica',
  'estado_atual',
  'certificacao',
  'periodo_formacao',
  'link',
  'estrutura',
  'inconsistencia',
] as const;
export type ClaimKind = (typeof claimKinds)[number];

/** Afirmação que exige a SUA confirmação (ou comprovação) antes de ser usada. */
export const claimSchema = z
  .object({
    id,
    blockId: z.string().min(1),
    kind: z.enum(claimKinds),
    quote: z.string().min(1),
    question: z.string().min(1),
    status: z.enum(['pendente', 'confirmada', 'rejeitada']).default('pendente'),
    /** Como foi resolvida (só você resolve): declaração sua e evidências técnicas, separadas. */
    resolution: z
      .object({
        at: isoDate,
        by: z.literal('proprietario'),
        note: z.string().min(1),
        basis: z.array(basisSchema).default([]),
      })
      .optional(),
  })
  .refine((c) => (c.status === 'pendente') === (c.resolution === undefined), {
    message: 'afirmação resolvida exige resolution, e resolution só existe quando resolvida',
  });
export type Claim = z.infer<typeof claimSchema>;

const proposalSchema = z.object({
  id,
  kind: z.enum(['resumo', 'destaque']),
  area: z.enum(AREAS).optional(),
  projectId: z.string().optional(),
  variant: z.enum(['sem-numeros', 'com-numeros', 'verbatim']),
  text: z.string().min(1),
  /** Cada trecho é cópia exata (salvo a 1ª letra maiúscula) de um bloco do mestre. */
  composedFrom: z
    .array(z.object({ blockId: z.string().min(1), fragment: z.string().min(1) }))
    .min(1),
  flags: z.array(z.string()).default([]),
  status: z.literal('proposta'),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const cvMasterSchema = z
  .object({
    schemaVersion: z.literal(1),
    language: z.literal('pt-BR'),
    master: z.object({
      sha256: sha256Hex,
      /** Só o nome do arquivo (sem caminho). */
      label: z.string().min(1),
      pages: z.number().int().min(1),
      extractedAt: isoDate,
      extractor: z.object({ name: z.string().min(1), version: z.string().min(1) }),
    }),
    identity: z.object({
      name: fact,
      headline: variantBlockSchema,
      location: fact,
      contacts: z
        .array(
          z.object({
            id,
            kind: z.enum(['email', 'telefone']),
            value: z.string().min(1),
            sourceRef: sourceRefSchema,
          }),
        )
        .min(1),
      links: z.array(linkSchema).default([]),
    }),
    summary: variantBlockSchema,
    /** Títulos de seção aprovados por você (o PDF usa "Experiência profissional" e "Projetos"). */
    sectionTitles: z
      .object({
        experience: z.string().min(1),
        projects: z.string().min(1),
        ...curatedStamp,
      })
      .optional(),
    experience: z.array(entrySchema).default([]),
    projects: z.array(entrySchema).default([]),
    skills: z
      .array(
        z.object({
          id,
          category: z.string().min(1),
          items: z.array(z.string().min(1)).min(1),
          text: z.string().min(1),
          /** Versão revisada por você; a do PDF fica intacta acima. */
          curated: z
            .object({
              items: z.array(z.string().min(1)).min(1),
              text: z.string().min(1),
              ...curatedStamp,
            })
            .optional(),
          sourceRef: sourceRefSchema,
        }),
      )
      .min(1),
    education: z
      .array(
        z.object({
          id,
          text: z.string().min(1),
          course: z.string().min(1),
          institution: z.string().min(1),
          statusLabel: z.string().min(1),
          status: z.enum(['cursando', 'concluido']),
          sourceRef: sourceRefSchema,
        }),
      )
      .min(1),
    languages: z
      .array(z.object({ id, text: z.string().min(1), sourceRef: sourceRefSchema }))
      .default([]),
    certifications: z
      .array(
        z.object({
          id,
          text: z.string().min(1),
          title: z.string().min(1),
          issuer: z.string().min(1),
          year: z.number().int().min(1990).max(2100),
          description: z.string().min(1).optional(),
          /** Só o que você confirmou contra o comprovante; `withheld` = campos do PDF ainda não conferidos. */
          curated: z
            .object({
              text: z.string().min(1),
              title: z.string().min(1),
              issuer: z.string().min(1),
              withheld: z.array(z.enum(['year', 'description'])).default([]),
              ...curatedStamp,
            })
            .optional(),
          sourceRef: sourceRefSchema,
        }),
      )
      .default([]),
    /** Afirmações a confirmar. Todas nascem `pendente`. */
    claims: z.array(claimSchema).default([]),
    /** Variantes/destaques PROPOSTOS: não fazem parte do currículo até você aprová-los. */
    proposals: z
      .object({
        items: z.array(proposalSchema).default([]),
        notProposed: z
          .array(z.object({ area: z.enum(AREAS), reason: z.string().min(1) }))
          .default([]),
      })
      .default({ items: [], notProposed: [] }),
    /** Aprovação do modelo inteiro (hash do conteúdo). Ausente até você aprovar. */
    approval: z.object({ approvedAt: isoDate, modelHash: sha256Hex }).optional(),
  })
  .superRefine((model, ctx) => {
    // Ids únicos em todo o modelo: a seleção, os validadores e o histórico referenciam blocos por id.
    const seen = new Set<string>();
    const add = (value: string, path: (string | number)[]): void => {
      if (seen.has(value)) ctx.addIssue({ code: 'custom', path, message: `id repetido: ${value}` });
      seen.add(value);
    };
    const block = (
      b: { id: string; variants: { id: string }[] },
      path: (string | number)[],
    ): void => {
      add(b.id, [...path, 'id']);
      b.variants.forEach((v, i) => {
        add(v.id, [...path, 'variants', i, 'id']);
      });
    };
    block(model.identity.headline, ['identity', 'headline']);
    block(model.summary, ['summary']);
    model.identity.links.forEach((l, i) => {
      add(l.id, ['identity', 'links', i, 'id']);
    });
    for (const [key, list] of [
      ['experience', model.experience],
      ['projects', model.projects],
    ] as const) {
      list.forEach((entry, i) => {
        add(entry.id, [key, i, 'id']);
        entry.bullets.forEach((b, j) => {
          block(b, [key, i, 'bullets', j]);
        });
        entry.links.forEach((l, j) => {
          add(l.id, [key, i, 'links', j, 'id']);
        });
      });
    }
    model.skills.forEach((s, i) => {
      add(s.id, ['skills', i, 'id']);
    });
    model.education.forEach((e, i) => {
      add(e.id, ['education', i, 'id']);
    });
    model.languages.forEach((l, i) => {
      add(l.id, ['languages', i, 'id']);
    });
    model.certifications.forEach((c, i) => {
      add(c.id, ['certifications', i, 'id']);
    });
    const blocks = [
      model.identity.headline,
      model.summary,
      ...model.experience.flatMap((e) => e.bullets),
      ...model.projects.flatMap((e) => e.bullets),
    ];
    // Variante editada deriva de uma variante do mestre que existe no modelo.
    const masterIds = new Set(
      blocks.flatMap((b) => b.variants.filter((v) => v.origin === 'mestre').map((v) => v.id)),
    );
    for (const b of blocks)
      for (const v of b.variants)
        if (v.derivedFrom !== undefined && !masterIds.has(v.derivedFrom))
          ctx.addIssue({
            code: 'custom',
            path: ['variants', v.id, 'derivedFrom'],
            message: `derivedFrom aponta para variante do mestre inexistente: ${v.derivedFrom}`,
          });
    // Aprovação obsoleta: o conteúdo mudou depois de aprovado, então a aprovação não vale mais.
    if (model.approval !== undefined && model.approval.modelHash !== modelHash(model)) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval', 'modelHash'],
        message: 'aprovação obsoleta: o conteúdo do modelo mudou depois de aprovado',
      });
    }
    // Aprovação do modelo inteiro: todo bloco precisa de ao menos uma variante aprovada
    // (as demais variantes simplesmente não valem).
    if (
      model.approval !== undefined &&
      blocks.some((b) => b.variants.every((v) => v.status !== 'aprovado'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message:
          'o modelo só pode ser aprovado com todos os blocos com ao menos uma variante aprovada',
      });
    }
  });

export type CvMaster = z.infer<typeof cvMasterSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type CvLink = z.infer<typeof linkSchema>;
export type VariantBlock = z.infer<typeof variantBlockSchema>;

// ------------------------------------------------------------------ hash canônico

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** JSON com chaves ordenadas: o mesmo conteúdo gera sempre os mesmos bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** Hash do conteúdo do currículo (identidade, resumo, experiências, projetos, skills, formação...). */
export function modelHash(model: CvMaster): string {
  // Fora do hash: afirmações a confirmar, propostas e a aprovação (não são conteúdo do currículo).
  const content: Partial<CvMaster> = { ...model };
  delete content.claims;
  delete content.proposals;
  delete content.approval;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

export const sha256Text = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
