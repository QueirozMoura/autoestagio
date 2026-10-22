import { norm } from './areas.js';

/**
 * Onde, na descrição da vaga, uma frase aparece. É isso que separa requisito obrigatório de
 * diferencial: "inglês avançado" em "Requisitos" é obrigatório; em "Diferenciais", não.
 */
export type Context = 'requisito' | 'diferencial' | 'outro' | 'desconhecido';

export interface Segment {
  /** Frase original (para evidência). */
  text: string;
  /** Frase sem acentos e em minúsculas (para as buscas). */
  norm: string;
  context: Context;
}

const DIFFERENTIAL_HEADING =
  /^(?:diferenci(?:al|ais)|desejavel|desejaveis|nice to have|bonus|sera um diferencial|preferred|good to have|plus|conhecimentos? desejaveis?|valorizamos)\b/;
const REQUIRED_HEADING =
  /^(?:requisitos?|pre-?requisitos?|requirements?|qualifications?|what you('| )?ll need|must have|o que (?:esperamos|buscamos|procuramos|precisa|voce precisa|exigimos)|voce (?:precisa|deve)|obrigatorio|conhecimentos? (?:obrigatorios?|necessarios?|tecnicos?)|perfil (?:da vaga|desejado|do candidato)|quem buscamos|quem procuramos|sobre voce|who you are|you have|your profile)\b/;
const OTHER_HEADING =
  /^(?:responsabilidades|atividades|o que voce vai fazer|beneficios|benefits|sobre\b|about\b|processo seletivo|como funciona|etapas|what you('| )?ll do|responsibilities|nossa cultura|por que|informacoes|detalhes|local\b|horario|bolsa|remuneracao|the role|a vaga|why\b)/;

function headingContext(normalized: string): Context | undefined {
  if (DIFFERENTIAL_HEADING.test(normalized)) return 'diferencial';
  if (REQUIRED_HEADING.test(normalized)) return 'requisito';
  if (OTHER_HEADING.test(normalized)) return 'outro';
  return undefined;
}

const OPTIONAL_MARKER =
  /\b(?:diferenci(?:al|ais)|desejavel|desejaveis|nice to have|a plus|plus|bonus|preferencia|preferred|valorizamos)\b/;
const REQUIRED_MARKER =
  /\b(?:obrigatori\w*|necessari\w*|exigid\w*|imprescindiv\w*|indispensav\w*|must|required|essencial|exigimos|requer)\b/;

function clean(line: string): string {
  return line
    .replace(/^[\s\-•*·–]+/, '')
    .replace(/[*_#]+/g, '')
    .trim();
}

/** Divide a descrição (texto simples) em frases, cada uma com o contexto em que aparece. */
export function segmentDescription(description: string): Segment[] {
  const segments: Segment[] = [];
  let section: Context = 'desconhecido';

  const emit = (text: string, sectionContext: Context): void => {
    for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
      const trimmed = sentence.trim();
      if (trimmed === '') continue;
      const n = norm(trimmed);
      let context = sectionContext;
      if (OPTIONAL_MARKER.test(n)) context = 'diferencial';
      else if (REQUIRED_MARKER.test(n)) context = 'requisito';
      segments.push({ text: trimmed, norm: n, context });
    }
  };

  for (const rawLine of description.split(/\r?\n/)) {
    const line = clean(rawLine);
    if (line === '') continue;
    const n = norm(line);

    const colon = /^([^:]{1,60}):\s*(.*)$/.exec(line);
    if (colon) {
      const heading = headingContext(norm(clean(colon[1] ?? '')));
      if (heading !== undefined) {
        section = heading;
        if ((colon[2] ?? '').trim() !== '') emit(colon[2] ?? '', section);
        continue;
      }
    }
    if (line.length <= 60 && !/[.;!?]$/.test(line)) {
      const heading = headingContext(n);
      if (heading !== undefined) {
        section = heading;
        continue;
      }
    }
    emit(line, section);
  }
  return segments;
}

export type Strength = 'obrigatorio' | 'diferencial' | 'fraco' | 'ignorar';

/**
 * Força de uma menção. `factual` = condições da vaga por natureza (curso, semestre, carga
 * horária, início): valem como obrigatórias mesmo fora de "Requisitos", salvo se forem
 * diferenciais. Para idioma e tecnologia, só "Requisitos" (ou palavra como "obrigatório")
 * é obrigatório; sem contexto claro a menção é `fraco`; em benefícios/responsabilidades, `ignorar`.
 */
export function strengthOf(segment: Segment, factual: boolean): Strength {
  switch (segment.context) {
    case 'requisito':
      return 'obrigatorio';
    case 'diferencial':
      return 'diferencial';
    case 'outro':
      return factual ? 'obrigatorio' : 'ignorar';
    case 'desconhecido':
      return factual ? 'obrigatorio' : 'fraco';
  }
}
