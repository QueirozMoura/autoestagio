import { maskEmail, maskPhone, nameParts, type Applicant } from './applicant.js';
import type { FieldModel, FillAction, FillPlan, FormModel, NeedsHuman } from './types.js';

/**
 * Decide, de forma pura e testável, o que preencher em um formulário. Regras:
 *  - só dados comprovados do candidato e a pretensão da política; nunca se inventa resposta;
 *  - autodeclaração (gênero, raça, deficiência...) e aceite de termos NUNCA são preenchidos: dependem de você;
 *  - disponibilidade presencial, autorização de trabalho e perguntas livres dependem de você;
 *  - campo opcional sem dado comprovado fica em branco; obrigatório sem dado impede o envio (pendência).
 */
export interface PlanContext {
  applicant: Applicant;
  /** Pretensão salarial mensal (da política). */
  salary: number;
  /** Respostas que VOCÊ confirmou para esta candidatura (config/answers.json). */
  answers?: { question: string; answer: string; source: string }[];
  /** Currículo aprovado a anexar (caminho local), se houver. */
  cv: { path: string; label: string } | null;
  /** Fatos do perfil aprovado (formação e idiomas) para preencher campos de formação e dar dicas nas perguntas de idioma. */
  profile?: {
    course: string;
    institution: string;
    graduationYear: number;
    graduationMonth?: number | undefined;
    /** Tipo da graduação em andamento no perfil (ex.: tecnologo, bacharelado). */
    degreeType?: string | undefined;
    languages: { language: string; level: string; scope?: string | undefined }[];
  };
}

const norm = (value: string): string =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const SENSITIVE =
  /(genero|gender|raca|race|etnia|ethnic|cor\/raca|pronome|pronoun|orientacao sexual|sexual orientation|deficiencia|disability|veteran|lgbt|transgen|autodeclar|self-?identif|voluntary|eeo|diversidade|diversity survey|indigena|hispanic)/;
/** Documentos de identificação: o agente nunca digita (nem tem esse dado). */
const DOCUMENT =
  /(^|[^a-z])(cpf|rg|cnh|passaporte|passport|ssn|documento de identidade|carteira de identidade|titulo de eleitor)([^a-z]|$)/;
const CONSENT =
  /(li e (aceito|concordo)|aceito (os )?termos|concordo com|politica de privacidade|privacy|lgpd|consent|termos de uso|terms (of|and)|i (agree|accept)|estou ciente|autoriza.*dados pessoais|utilizar seus dados|compartilhar (as )?informacoes|estou de acordo)/;
const LANGUAGE =
  /(proficiencia|nivel|level|fluencia|fluency).*(ingles|english|espanhol|spanish|frances|french|alemao|german)|(ingles|english|espanhol|spanish).*(proficiencia|nivel|level|fluencia)/;
const AVAILABILITY =
  /(disponibilidade|disponivel|available|dispo).*(presencial|hibrid|on-?site|escritorio|office|viajar|travel|mudar|relocat)|(presencial|on-?site|hibrid).*(disponibilidade|disponivel|available)|relocat|mudan[cç]a de cidade/;
const AUTHORIZATION =
  /(autoriza[cç][aã]o de trabalho|work authori|legally (authori|permitted)|visa|sponsorship|permiss[aã]o de trabalho)/;

const text = (field: FieldModel): string =>
  norm([field.label, field.name, field.placeholder, field.section].join(' | '));
const labelOnly = (field: FieldModel): string =>
  norm([field.label, field.name, field.placeholder].join(' '));

/** Mesmo número sem o +55: com máscara "(11) 99999-9999" e só dígitos. */
const nationalPhones = (e164: string): string[] => {
  const match = /^\+55(\d{2})(9?\d{4})(\d{4})$/.exec(e164);
  return match === null
    ? []
    : [
        `(${match[1] ?? ''}) ${match[2] ?? ''}-${match[3] ?? ''}`,
        `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}`,
      ];
};

const MONTHS = [
  'janeiro',
  'fevereiro',
  'marco',
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
const monthForms = (month: number): string[] =>
  [String(month).padStart(2, '0'), MONTHS[month - 1] ?? ''].filter((m) => m !== '');
const degreeWord = (type: string): string =>
  ({ tecnologo: 'Tecnólogo', bacharelado: 'Graduação', licenciatura: 'Graduação' })[type] ?? '';

const formatPhone = (e164: string): string => {
  const match = /^\+55(\d{2})(9?\d{4})(\d{4})$/.exec(e164);
  return match === null ? e164 : `+55 ${match[1] ?? ''} ${match[2] ?? ''}-${match[3] ?? ''}`;
};

interface Intent {
  value: string;
  source: string;
  masked?: boolean;
  alternatives?: string[];
}

function textIntent(field: FieldModel, ctx: PlanContext): Intent | null {
  const { applicant } = ctx;
  const t = labelOnly(field);
  const { first, last } = nameParts(applicant.fullName);
  if (field.kind === 'email' || /e-?mail/.test(t))
    return { value: applicant.email, source: 'applicant.email', masked: true };
  if (field.kind === 'tel' || /(telefone|celular|phone|whatsapp|mobile)/.test(t))
    return {
      value: formatPhone(applicant.phone),
      source: 'applicant.phone',
      masked: true,
      alternatives: nationalPhones(applicant.phone),
    };
  if (/linkedin/.test(t))
    return applicant.linkedin === undefined
      ? null
      : { value: applicant.linkedin, source: 'applicant.linkedin' };
  if (/github/.test(t))
    return applicant.github === undefined
      ? null
      : { value: applicant.github, source: 'applicant.github' };
  if (/(portfolio|website|site pessoal|personal (site|website)|pagina pessoal)/.test(t))
    return applicant.portfolio === undefined
      ? null
      : { value: applicant.portfolio, source: 'applicant.portfolio' };
  if (
    /(pretensao salarial|expectativa salarial|salary expectation|expected salary|desired salary|remuneracao (desejada|pretendida)|bolsa pretendida|pretensao)/.test(
      t,
    )
  )
    return { value: String(ctx.salary), source: 'politica.salaryExpectation' };
  if (
    /(first name|primeiro nome|given name|^nome$)/.test(t) &&
    !/(completo|full|sobrenome|last)/.test(t) &&
    /(first|primeiro|given)/.test(t)
  )
    return { value: first, source: 'applicant.fullName' };
  if (/(last name|sobrenome|surname|family name|ultimo nome)/.test(t))
    return { value: last, source: 'applicant.fullName' };
  if (
    /(nome completo|full name|your name|seu nome|^nome\b|^name\b)/.test(t) &&
    !/(empresa|company|escola|school|pai|mae|universidade|faculdade|instituicao|institution|university|curso|disciplina)/.test(
      t,
    )
  )
    return { value: applicant.fullName, source: 'applicant.fullName' };
  if (ctx.profile !== undefined) {
    if (
      /(mes de conclusao|graduation month|month of graduation)/.test(t) &&
      ctx.profile.graduationMonth !== undefined
    )
      return {
        value: String(ctx.profile.graduationMonth),
        source: 'perfil.education.expectedGraduationMonth',
        alternatives: monthForms(ctx.profile.graduationMonth),
      };
    if (
      /^(grau|degree|escolaridade|nivel de formacao|nivel de escolaridade)\b/.test(t) &&
      ctx.profile.degreeType !== undefined &&
      degreeWord(ctx.profile.degreeType) !== ''
    )
      return { value: degreeWord(ctx.profile.degreeType), source: 'perfil.education.degreeType' };
    if (/(ano de conclusao|graduation year|year of graduation|ano de formatura)/.test(t))
      return {
        value: String(ctx.profile.graduationYear),
        source: 'perfil.education.expectedGraduationYear',
      };
    if (/(instituicao|universidade|faculdade|institution|university|\bcollege\b)/.test(t))
      return { value: ctx.profile.institution, source: 'perfil.education.institution' };
    if (/^(curso|course|major|field of study|area de estudo|disciplina)\b/.test(t))
      return { value: ctx.profile.course, source: 'perfil.education.course' };
  }
  if (/(cidade|^city\b|\bcity\b|municipio)/.test(t) && !/(pais|country)/.test(t))
    return { value: applicant.city, source: 'applicant.city' };
  if (/(pais|country)/.test(t)) return { value: applicant.country, source: 'applicant.country' };
  return null;
}

function optionMatching(field: FieldModel, wanted: readonly string[]): string | undefined {
  return field.options.find((option) =>
    wanted.some((w) => norm(option) === norm(w) || norm(option).startsWith(`${norm(w)} (`)),
  );
}

export function planForm(form: FormModel, ctx: PlanContext): FillPlan {
  const actions: FillAction[] = [];
  const needsHuman: NeedsHuman[] = [];
  const skipped: FillPlan['skipped'] = [];
  const human = (field: FieldModel, category: NeedsHuman['category'], why: string): void => {
    needsHuman.push({
      fieldId: field.id,
      label: field.label || field.name,
      category,
      required: field.required,
      why,
    });
  };
  const add = (field: FieldModel, op: FillAction['op'], intent: Intent): void => {
    actions.push({
      fieldId: field.id,
      label: field.label || field.name,
      op,
      value: intent.value,
      source: intent.source,
      masked: intent.masked === true,
      ...(intent.alternatives === undefined || intent.alternatives.length === 0
        ? {}
        : { alternatives: intent.alternatives }),
    });
  };

  for (const field of form.fields) {
    const t = text(field);
    const name = field.label || field.name || '(sem rótulo)';

    // 0) Resposta que você confirmou para ESTA pergunta nesta candidatura (nunca vale para documentos).
    const confirmed = DOCUMENT.test(t)
      ? undefined
      : ctx.answers?.find((a) => t.includes(norm(a.question)));
    if (confirmed !== undefined) {
      if (
        field.kind === 'radio' ||
        field.kind === 'checkbox' ||
        field.kind === 'file' ||
        field.kind === 'textarea'
      )
        human(
          field,
          'confirmacao',
          'há resposta confirmada por você, mas este tipo de campo o executor não marca: responda na página',
        );
      else if (
        field.options.length > 0 &&
        !field.options.some((o) => norm(o) === norm(confirmed.answer))
      )
        human(
          field,
          'confirmacao',
          `a opção "${confirmed.answer}" não existe na lista: inconsistência, nada foi alterado`,
        );
      else
        add(
          field,
          field.kind === 'select'
            ? 'select'
            : field.kind === 'text' ||
                field.kind === 'email' ||
                field.kind === 'tel' ||
                field.kind === 'url' ||
                field.kind === 'number'
              ? 'fill'
              : 'choose',
          {
            value: confirmed.answer,
            source: confirmed.source,
          },
        );
      continue;
    }
    // 1) O que NUNCA se preenche sozinho.
    if (DOCUMENT.test(t)) {
      human(
        field,
        'sensivel',
        'documento de identificação (ex.: CPF): nunca é preenchido pelo agente; digite você',
      );
      continue;
    }
    if (SENSITIVE.test(t)) {
      human(field, 'sensivel', 'autodeclaração/dado sensível: nunca é preenchido nem presumido');
      continue;
    }
    if (CONSENT.test(t)) {
      human(field, 'consentimento', 'aceite de termos/privacidade exige a sua decisão');
      continue;
    }
    if (AVAILABILITY.test(t)) {
      human(
        field,
        'confirmacao',
        'disponibilidade presencial/mudança exige informação confirmada por você',
      );
      continue;
    }
    if (LANGUAGE.test(t)) {
      const wanted = /(ingles|english)/.test(t)
        ? 'ingl'
        : /(espanhol|spanish)/.test(t)
          ? 'espan'
          : '';
      const known = ctx.profile?.languages.find(
        (l) => norm(l.language).startsWith(wanted) && wanted !== '',
      );
      human(
        field,
        'desconhecido',
        known === undefined
          ? 'idioma sem dado comprovado no perfil: nada é presumido'
          : `perfil: ${known.language} ${known.level}${known.scope === undefined ? '' : ` (${known.scope})`}; a escala do formulário é sua`,
      );
      continue;
    }
    if (AUTHORIZATION.test(t)) {
      human(field, 'desconhecido', 'autorização de trabalho: sem dado comprovado no perfil');
      continue;
    }

    // 2) Currículo.
    if (field.kind === 'file') {
      if (/(carta|cover|apresenta[cç]|portfolio|historico|transcript|certificad)/.test(t)) {
        if (field.required)
          human(field, 'desconhecido', 'documento obrigatório sem arquivo aprovado');
        else
          skipped.push({
            fieldId: field.id,
            label: name,
            why: 'documento opcional: sem arquivo aprovado',
          });
      } else if (ctx.cv === null) human(field, 'desconhecido', 'sem currículo aprovado disponível');
      else add(field, 'upload', { value: ctx.cv.path, source: `curriculo:${ctx.cv.label}` });
      continue;
    }

    // 3) Campos de texto e listas com dado comprovado.
    if (field.kind === 'radio' || field.kind === 'checkbox') {
      if (field.required)
        human(field, 'desconhecido', 'pergunta sem resposta comprovada no perfil');
      else
        skipped.push({ fieldId: field.id, label: name, why: 'opcional: sem resposta comprovada' });
      continue;
    }
    const intent = textIntent(field, ctx);
    if (intent !== null) {
      if (field.kind === 'select' || field.kind === 'combobox') {
        const op = field.kind === 'combobox' ? 'choose' : 'select';
        const wanted =
          intent.source === 'applicant.country'
            ? ['Brasil', 'Brazil']
            : intent.source === 'applicant.city'
              ? [ctx.applicant.city]
              : [intent.value];
        const option = optionMatching(field, wanted);
        const other = field.options.find((o) => norm(o) === 'outra' || norm(o) === 'outro');
        if (option !== undefined) add(field, op, { ...intent, value: option });
        else if (
          intent.source === 'perfil.education.institution' &&
          other !== undefined &&
          /(selecion\w+\W{0,3}(a\W{0,3})?outra)/.test(norm(field.label))
        )
          // O próprio formulário instrui: instituição fora da lista → "Outra". O dado (Uniasselvi) é comprovado.
          add(field, op, {
            value: other,
            source:
              'perfil.education.institution (fora da lista; o formulário manda escolher "Outra")',
          });
        else
          human(
            field,
            'desconhecido',
            'a lista não tem uma opção que corresponda ao dado comprovado',
          );
      } else if (field.value !== '' && norm(field.value) !== norm(intent.value)) {
        human(field, 'confirmacao', 'o campo já vem preenchido com outro valor: não é sobrescrito');
      } else if (field.kind === 'textarea') {
        human(field, 'desconhecido', 'texto livre: não é escrito automaticamente');
      } else add(field, 'fill', intent);
      continue;
    }

    // 4) Estado (somente se a lista tiver a opção exata do dado comprovado).
    if (
      field.kind === 'select' &&
      /(estado|\bstate\b|\buf\b)/.test(labelOnly(field)) &&
      ctx.applicant.state !== undefined
    ) {
      const option = optionMatching(field, [ctx.applicant.state]);
      if (option !== undefined) {
        add(field, 'select', { value: option, source: 'applicant.state' });
        continue;
      }
    }

    // 5) Todo o resto: obrigatório vira pendência; opcional fica em branco.
    if (field.required)
      human(field, 'desconhecido', 'pergunta obrigatória sem resposta comprovada no perfil');
    else skipped.push({ fieldId: field.id, label: name, why: 'opcional: sem dado comprovado' });
  }
  const seen = new Set<string>();
  const dedupedHuman = needsHuman.filter((h) => {
    const key = `${h.category}|${norm(h.label)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { actions, needsHuman: dedupedHuman, skipped };
}

/** Valor para registros: e-mail e telefone mascarados. */
export function displayValue(action: FillAction, applicant: Applicant): string {
  if (!action.masked) return action.value;
  return action.source === 'applicant.email' ? maskEmail(applicant.email) : maskPhone(action.value);
}
