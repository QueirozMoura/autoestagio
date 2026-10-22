function plain(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const INTERNSHIP = /\b(?:estagi\w*|interns?|internship)\b/;

/**
 * O título indica estágio. "Trainee" e "Jovem Aprendiz" ficam de fora de propósito: são programas
 * para recém-formados e para ensino médio, e não servem para quem cursa graduação.
 */
export function isInternshipTitle(title: string): boolean {
  return INTERNSHIP.test(plain(title));
}

const BRAZIL =
  /\b(?:brazil|brasil|latam|latin america|sao paulo|rio de janeiro|belo horizonte|curitiba|porto alegre|recife|florianopolis|campinas|brasilia|salvador|fortaleza|goiania|sp)\b/;

export function isBrazilLocation(...locations: (string | null | undefined)[]): boolean {
  return locations.some((location) => location != null && BRAZIL.test(plain(location)));
}

const IT_TERMS =
  /\b(?:ti|t\.i|tecnologia|desenvolv\w*|developer|dev|software|engenharia de (?:software|dados|computacao)|engineer\w*|dados|data|qa|quality|qualidade|suporte tecnico|technical support|help ?desk|service ?desk|infra\w*|devops|sre|seguranca da informacao|security|cyber\w*|machine learning|ia|ai|cloud|back ?end|front ?end|full ?stack|sistemas|analytics|bi)\b/;

/**
 * Heurística (não é decisão de elegibilidade): o texto cita termos de tecnologia. Serve para
 * relatórios; quem decide se a vaga serve é a análise, em etapa futura.
 */
export function isItRelated(...texts: (string | null | undefined)[]): boolean {
  return texts.some((text) => text != null && IT_TERMS.test(plain(text)));
}

const NAMED: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * A API do Greenhouse devolve o HTML da descrição escapado ("&lt;p&gt;"). Desfaz uma camada de
 * escape para que o HTML volte a ser HTML; a limpeza em texto é feita na normalização.
 */
export function unescapeEntities(value: string): string {
  return value.replace(/&(#39|#x27|lt|gt|amp|quot|apos|nbsp);/gi, (whole, entity: string) => {
    if (entity === '#39' || entity.toLowerCase() === '#x27') return "'";
    return NAMED[entity.toLowerCase()] ?? whole;
  });
}

/** Converte uma data da fonte em ISO 8601 UTC; datas ausentes ou inválidas viram `undefined`. */
export function toIsoDate(value: string | number | null | undefined): string | undefined {
  if (value == null) return undefined;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}
