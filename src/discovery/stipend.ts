import { stripAccents } from './text.js';

export interface Stipend {
  /** Menor valor mensal informado (em faixas, o piso; é o valor conservador para o mínimo). */
  min: number;
  max: number;
  currency: 'BRL';
}

export interface StipendInfo {
  /** Texto original publicado, preservado para auditoria. */
  text: string | null;
  /** `null` quando não há valor mensal confiável (a combinar, por hora, sem R$ etc.). */
  stipend: Stipend | null;
}

const MIN_PLAUSIBLE = 100;
const MAX_PLAUSIBLE = 100_000;
const MAX_TEXT_LENGTH = 200;

/** Interpreta números no formato brasileiro ("1.800,50") e também "1,800.50" e "1800". */
export function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[.,]+$/, '');
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  let normalized: string;

  if (lastDot !== -1 && lastComma !== -1) {
    // Os dois separadores: o último é o decimal.
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    normalized = cleaned.split(thousands).join('').replace(decimal, '.');
  } else if (lastDot !== -1 || lastComma !== -1) {
    const separator = lastDot !== -1 ? '.' : ',';
    const parts = cleaned.split(separator);
    const last = parts[parts.length - 1] ?? '';
    // "1.200" é milhar; "1.5" ou "1,50" é decimal.
    normalized = parts.length > 2 || last.length === 3 ? parts.join('') : parts.join('.');
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

const UNKNOWN_AMOUNT =
  /a combinar|combinar|nao informad|nao divulgad|compativel com o mercado|competitiv/;
const NOT_MONTHLY = /(?:\/\s*h\b|por hora|\bhora\b|\bhr\b|por dia|\banual\b|por ano|\/\s*ano)/;
const AMOUNT = /(?:r\$|brl)\s*(\d[\d.,]*)/;
const RANGE = /(?:r\$|brl)\s*(\d[\d.,]*)\s*(?:a|ate|-|–|—)\s*(?:r\$|brl)?\s*(\d[\d.,]*)/;

function plausible(value: number | null): value is number {
  return value !== null && value >= MIN_PLAUSIBLE && value <= MAX_PLAUSIBLE;
}

/**
 * Extrai o valor mensal de um texto de remuneração. Só aceita valores com "R$" explícito:
 * nada é presumido. Na dúvida, devolve `null` e a vaga fica pendente de análise.
 */
export function parseStipend(text: string): Stipend | null {
  const t = stripAccents(text).toLowerCase();
  if (UNKNOWN_AMOUNT.test(t) || NOT_MONTHLY.test(t)) return null;

  const range = RANGE.exec(t);
  if (range) {
    const low = parseNumber(range[1] ?? '');
    const high = parseNumber(range[2] ?? '');
    if (plausible(low) && plausible(high)) {
      return { min: Math.min(low, high), max: Math.max(low, high), currency: 'BRL' };
    }
  }

  // Sem faixa explícita, vale apenas o primeiro valor (os demais costumam ser benefícios).
  const first = AMOUNT.exec(t);
  const value = parseNumber(first?.[1] ?? '');
  return plausible(value) ? { min: value, max: value, currency: 'BRL' } : null;
}

function clip(text: string): string {
  return text.trim().slice(0, MAX_TEXT_LENGTH);
}

/**
 * Usa o texto de remuneração informado pela fonte; se não houver, procura um trecho com a
 * palavra "bolsa" na descrição.
 */
export function extractStipend(
  compensationText: string | undefined,
  description: string | null,
): StipendInfo {
  if (compensationText !== undefined && compensationText.trim() !== '') {
    return { text: clip(compensationText), stipend: parseStipend(compensationText) };
  }
  const snippet = /bolsa(?:[-\s]aux[ií]lio)?[^\n\r]{0,60}/i.exec(description ?? '')?.[0];
  if (snippet !== undefined && /\d/.test(snippet)) {
    return { text: clip(snippet), stipend: parseStipend(snippet) };
  }
  return { text: null, stipend: null };
}
