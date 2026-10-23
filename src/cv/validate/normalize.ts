/**
 * Normalização do texto extraído, restrita a diferenças de EXTRAÇÃO justificadas. Nenhuma regra mexe em
 * palavras, números, URLs nem em hífens do meio da linha: duas strings só ficam iguais depois de normalizar
 * se diferiam apenas pelo que está na lista abaixo.
 */
export const NORMALIZATION_RULES = [
  {
    rule: 'unicode NFC',
    why: 'o mesmo caractere acentuado pode vir composto ou decomposto; NFC não funde formas de compatibilidade (diferente de NFKC, que esconderia ligaduras e variantes)',
  },
  {
    rule: 'remove espaços e quebras de linha',
    why: 'a posição dos espaços e das quebras é decisão de layout e muda entre extratores; as palavras continuam na mesma ordem',
  },
  {
    rule: 'remove "|" e "•"',
    why: 'são separadores e marcadores estruturais do layout (título | período, bullets); a contagem de "•" é conferida à parte',
  },
  {
    rule: 'remove caracteres invisíveis (hífen suave, espaços de largura zero, BOM)',
    why: 'não aparecem para quem lê e alguns extratores os inserem',
  },
  {
    rule: 'só no Poppler: remove "-" no FIM de linha',
    why: 'o Poppler junta palavras quebradas no hífen ("e-" + "commerce" → "ecommerce"); a regra vale dos dois lados da comparação e nunca para hífens no meio da linha',
  },
] as const;

const INVISIBLE = new RegExp('[\u00ad\u200b-\u200d\u2060\ufeff]', 'gu');

/** Forma comparável do texto (ver `NORMALIZATION_RULES`). Diferencia maiúsculas, números, URLs e hífens. */
export function squash(text: string): string {
  return text
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/[\s|•]+/gu, '');
}

/** Remove caracteres invisíveis (hífen suave, espaços de largura zero, BOM). */
export const stripInvisible = (text: string): string => text.replace(INVISIBLE, '');

/**
 * Texto "de leitura" para procurar frases: NFC, sem invisíveis, `|` e `•` viram espaço, espaços colapsados e
 * minúsculas. Mantém as FRONTEIRAS DE PALAVRA (diferente de `squash`), para frases não casarem no meio de outra.
 */
export const plainText = (text: string): string =>
  stripInvisible(text.normalize('NFC'))
    .replace(/[|•]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();

/** O caractere é ignorado por `squash` (espaço, quebra, separador estrutural ou invisível)? */
export const isIgnorableChar = (char: string): boolean =>
  /[\s|•]/u.test(char) || new RegExp(INVISIBLE.source, 'u').test(char);

/** Para comparar com o Poppler: remove o hífen que termina uma linha (ele junta as duas partes da palavra). */
export function dropLineEndHyphens(text: string): string {
  return text.replace(/-[ \t]*(?=\r?\n|$)/gu, '');
}

/** Um trecho de contexto (curto) em torno da primeira diferença entre duas strings já normalizadas. */
export function firstDifference(
  a: string,
  b: string,
): { at: number; a: string; b: string } | undefined {
  if (a === b) return undefined;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 20);
  return { at: i, a: a.slice(from, i + 30), b: b.slice(from, i + 30) };
}
