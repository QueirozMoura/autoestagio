import type { Channel } from '../applications/index.js';
import { norm } from '../eligibility/areas.js';
import type { Criterion } from '../eligibility/index.js';
import type { Profile } from '../config/index.js';

export type RequirementKind =
  'dado_ausente' | 'pergunta' | 'canal' | 'elegibilidade' | 'informativo';

export interface RequirementSpec {
  key: string;
  label: string;
  kind: RequirementKind;
  /** Bloqueante: a candidatura não fica "pronta para revisão" enquanto não for resolvida. */
  blocking: boolean;
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

/** Pedidos explícitos da vaga que o perfil aprovado não cobre. Nunca viram resposta automática. */
const ASKED: readonly {
  key: string;
  label: string;
  pattern: RegExp;
  blocking: boolean;
  kind: RequirementKind;
}[] = [
  {
    key: 'pretensao_salarial',
    label: 'A vaga pede pretensão salarial/de bolsa; o perfil aprovado não tem esse dado.',
    pattern:
      /\b(?:pretensao (?:salarial|de bolsa|financeira)|expectativa salarial|salary expectations?)\b/,
    blocking: true,
    kind: 'dado_ausente',
  },
  {
    key: 'link_portfolio',
    label: 'A vaga pede link de portfólio; o perfil aprovado não tem links.',
    pattern: /\b(?:portfolio|portifolio)\b/,
    blocking: true,
    kind: 'dado_ausente',
  },
  {
    key: 'link_github',
    label: 'A vaga pede link do GitHub; o perfil aprovado não tem links.',
    pattern: /\bgithub\b/,
    blocking: true,
    kind: 'dado_ausente',
  },
  {
    key: 'link_linkedin',
    label: 'A vaga pede link do LinkedIn; o perfil aprovado não tem links.',
    pattern: /\blinkedin\b/,
    blocking: true,
    kind: 'dado_ausente',
  },
  {
    key: 'historico_escolar',
    label: 'A vaga pede histórico escolar ou comprovante de matrícula; não há documento aprovado.',
    pattern:
      /\b(?:historico escolar|comprovante de matricula|declaracao de matricula|atestado de matricula)\b/,
    blocking: true,
    kind: 'dado_ausente',
  },
  {
    key: 'documentos_pessoais',
    label: 'A vaga pede documentos/dados pessoais (CPF, RG etc.); o perfil aprovado não os contém.',
    pattern: /\b(?:cpf|rg|carteira de trabalho|pis)\b/,
    blocking: true,
    kind: 'dado_ausente',
  },
  {
    key: 'carta_apresentacao',
    label: 'A vaga menciona carta de apresentação; a mensagem pode servir, confirme ao revisar.',
    pattern: /\b(?:carta de apresentacao|carta de motivacao|cover letter)\b/,
    blocking: false,
    kind: 'informativo',
  },
  {
    key: 'teste_tecnico',
    label:
      'A vaga menciona teste ou desafio técnico; é uma etapa posterior, sem preenchimento automático.',
    pattern: /\b(?:teste tecnico|desafio tecnico|coding challenge|take home)\b/,
    blocking: false,
    kind: 'informativo',
  },
];

/** Só conta como pedido se a mesma frase pede ao candidato (enviar, anexar, informar...). */
const REQUEST =
  /\b(?:envi\w+|anex\w+|inform\w+|inclu\w+|compartilh\w+|apresent\w+|preench\w+|link|url|obrigatori\w+|necessari\w+|submit|attach|provide|include)\b/;

export function detectRequirements(input: {
  description: string | null;
  channel: Channel | null;
  verdict: 'apto' | 'revisao_humana';
  eligibility: readonly Criterion[];
}): RequirementSpec[] {
  const specs: RequirementSpec[] = [];

  if (input.channel === null) {
    specs.push({
      key: 'canal',
      label: 'Defina o canal de envio (e-mail, portal ou manual).',
      kind: 'canal',
      blocking: true,
    });
  } else if (input.channel === 'email') {
    specs.push({
      key: 'destinatario_verificado',
      label:
        'Destinatário de e-mail verificado ainda não definido (Etapa 3.4); nenhum será presumido.',
      kind: 'canal',
      blocking: true,
    });
  } else if (input.channel === 'portal') {
    specs.push({
      key: 'formulario_portal',
      label:
        'Perguntas do formulário do portal ainda não lidas; nenhuma será preenchida automaticamente.',
      kind: 'pergunta',
      blocking: true,
    });
  }

  const sentences = (input.description ?? '').split(/(?<=[.;!?])\s+|\n+/).map((s) => norm(s));
  for (const asked of ASKED) {
    if (
      sentences.some(
        (sentence) =>
          asked.pattern.test(sentence) && (asked.kind === 'informativo' || REQUEST.test(sentence)),
      )
    ) {
      specs.push({
        key: asked.key,
        label: asked.label,
        kind: asked.kind,
        blocking: asked.blocking,
      });
    }
  }

  if (input.verdict === 'revisao_humana') {
    const seen = new Map<string, number>();
    for (const criterion of input.eligibility) {
      if (
        criterion.kind !== 'obrigatorio' ||
        criterion.outcome !== 'indeterminado' ||
        criterion.id === 'perfil'
      )
        continue;
      const n = (seen.get(criterion.id) ?? 0) + 1;
      seen.set(criterion.id, n);
      specs.push({
        key: n === 1 ? `elegibilidade:${criterion.id}` : `elegibilidade:${criterion.id}:${n}`,
        label: clip(criterion.detail, 240),
        kind: 'elegibilidade',
        blocking: true,
      });
    }
  }
  return specs;
}

// --------------------------------------------------------- perguntas de formulário

/** Dados que nunca são respondidos automaticamente, mesmo que "pareçam" simples. */
const SENSITIVE =
  /\b(?:cpf|rg|genero|sexo|raca|cor|etnia|deficiencia|pcd|religiao|orientacao|estado civil|data de nascimento|nascimento|idade|endereco|telefone|celular|whatsapp|salario|pretensao|bolsa|filhos|nacionalidade|renda)\b/;

type Answerer = (profile: Profile) => string | undefined;

/**
 * Lista fechada do que o perfil aprovado responde. A pergunta inteira precisa ser uma destas
 * formas simples; qualquer variação ("curso de inglês que você fez?") fica pendente para uma pessoa.
 */
const KNOWN: readonly (readonly [RegExp, Answerer])[] = [
  [/^nome(?: completo)?$/, (p) => p.name],
  [/^(?:cidade|cidade de residencia|cidade onde (?:voce )?mora)$/, (p) => p.city],
  [
    /^(?:curso|curso de graduacao|curso que (?:voce )?(?:esta )?cursa(?:ndo)?|graduacao)$/,
    (p) => p.education.course,
  ],
  [/^(?:instituicao(?: de ensino)?|faculdade|universidade)$/, (p) => p.education.institution],
  [
    /^(?:semestre|semestre atual)$/,
    (p) =>
      p.education.currentSemester === undefined
        ? undefined
        : `${p.education.currentSemester}º semestre`,
  ],
  [
    /^(?:previsao de (?:formatura|conclusao)(?: do curso)?|ano de (?:formatura|conclusao))$/,
    (p) =>
      `${p.education.expectedGraduationMonth === undefined ? '' : `${String(p.education.expectedGraduationMonth).padStart(2, '0')}/`}${p.education.expectedGraduationYear}`,
  ],
  [
    /^(?:disponibilidade(?: semanal| de horas)?|carga horaria(?: semanal)?|horas semanais)$/,
    (p) =>
      p.availability === undefined
        ? undefined
        : `${p.availability.hoursPerWeek.min} a ${p.availability.hoursPerWeek.max} horas semanais`,
  ],
  [
    /^(?:nivel de (?:ingles|english)|ingles|english)$/,
    (p) => {
      const english = p.languages?.find((entry) =>
        /^(?:ingles|english)$/i.test(norm(entry.language)),
      );
      if (english === undefined) return undefined;
      return english.scope === 'leitura-tecnica'
        ? `${english.level} (apenas leitura técnica e documentação; conversação não comprovada)`
        : english.level;
    },
  ],
];

export interface QuestionAnswer {
  key: string;
  label: string;
  /** `undefined` = desconhecida: fica pendente, sem resposta. */
  answer: string | undefined;
}

export function slug(text: string): string {
  return norm(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Responde com o perfil aprovado só o que está na lista fechada; sensível ou desconhecido = pendente. */
export function answerQuestion(profile: Profile, question: string): QuestionAnswer {
  const text = question.trim().slice(0, 240);
  const spoken = norm(text)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Tira só a moldura da pergunta ("qual é o seu ...").
  const normalized = spoken.replace(
    /^(?:(?:qual|quais) (?:e |sao )?|informe |digite |preencha )?(?:(?:o|a|seu|sua) )*/,
    '',
  );
  const key = `pergunta:${slug(text)}`;
  if (SENSITIVE.test(spoken)) return { key, label: text, answer: undefined };
  for (const [pattern, answerer] of KNOWN) {
    if (pattern.test(normalized)) return { key, label: text, answer: answerer(profile) };
  }
  return { key, label: text, answer: undefined };
}
