import type { Expected } from './expected.js';
import type { ExtractedPdf, LinkAnnotation, TextRun } from './extract.js';
import { dropLineEndHyphens, firstDifference, isIgnorableChar, squash } from './normalize.js';
import type { PopplerMode, PopplerText } from './poppler.js';

export type CheckId = 'H1' | 'H2' | 'H3' | 'H4';

export interface CheckResult {
  id: CheckId;
  name: string;
  /** Todas as verificações desta entrega são obrigatórias: falhar = o PDF não vale. */
  severity: 'hard';
  status: 'pass' | 'fail' | 'skipped';
  summary: string;
  details: string[];
}

const result = (
  id: CheckId,
  name: string,
  problems: string[],
  okSummary: string,
  notes: string[] = [],
): CheckResult => ({
  id,
  name,
  severity: 'hard',
  status: problems.length === 0 ? 'pass' : 'fail',
  summary: problems.length === 0 ? okSummary : `${problems.length} problema(s)`,
  details: [...problems, ...notes],
});

export const skipped = (id: CheckId, name: string, why: string): CheckResult => ({
  id,
  name,
  severity: 'hard',
  status: 'skipped',
  summary: why,
  details: [],
});

const clip = (text: string, max = 60): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

// ------------------------------------------------------------------ H1: integridade e páginas

export interface IntegrityInput {
  bytes: Buffer;
  /** Ausente quando o pdfjs não conseguiu ler o arquivo. */
  extracted: ExtractedPdf | undefined;
  readError: string | undefined;
  expected: Expected;
  expectedPages: number | undefined;
}

export function checkIntegrity(input: IntegrityInput): CheckResult {
  const { bytes, extracted, readError, expected, expectedPages } = input;
  const problems: string[] = [];
  if (bytes.length === 0) problems.push('arquivo vazio');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-')
    problems.push('não começa com o cabeçalho "%PDF-"');
  if (
    !bytes
      .subarray(Math.max(0, bytes.length - 1024))
      .toString('latin1')
      .includes('%%EOF')
  )
    problems.push('sem o marcador "%%EOF" no fim (arquivo truncado?)');
  if (readError !== undefined) problems.push(readError);
  if (extracted !== undefined) {
    if (extracted.pages < 1) problems.push('PDF sem páginas');
    if (extracted.pages > expected.maxPages)
      problems.push(`${extracted.pages} páginas; o limite é ${expected.maxPages}`);
    if (expectedPages !== undefined && extracted.pages !== expectedPages)
      problems.push(`${extracted.pages} páginas; o esperado era ${expectedPages}`);
    extracted.runsPerPage.forEach((count, i) => {
      if (count === 0) problems.push(`a página ${i + 1} está em branco (sem texto)`);
    });
  }
  return result(
    'H1',
    'integridade básica e quantidade de páginas',
    problems,
    `PDF íntegro, ${extracted?.pages ?? '?'} página(s), todas com texto`,
  );
}

// ------------------------------------------------------------------ H2: conteúdo bidirecional

export interface PopplerInput {
  mode: PopplerMode;
  text: PopplerText | undefined;
}

/** Notas e problemas do Poppler para uma comparação (compartilhado por H2 e H3). */
function popplerComparison(
  poppler: PopplerInput,
  pick: (text: PopplerText) => string | undefined,
  reference: string,
  referenceName: string,
): { problems: string[]; notes: string[] } {
  if (poppler.mode === 'off') return { problems: [], notes: ['Poppler desligado (mode "off")'] };
  const text = poppler.text;
  if (text === undefined || !text.available)
    return poppler.mode === 'require'
      ? { problems: ['Poppler exigido (mode "require"), mas não está disponível'], notes: [] }
      : {
          problems: [],
          notes: ['Poppler indisponível: verificação independente ignorada (mode "auto")'],
        };
  if (text.error !== undefined) return { problems: [text.error], notes: [] };
  const other = pick(text);
  if (other === undefined) return { problems: ['Poppler não devolveu texto'], notes: [] };
  const a = squash(dropLineEndHyphens(other));
  const b = squash(dropLineEndHyphens(reference));
  const diff = firstDifference(a, b);
  return diff === undefined
    ? {
        problems: [],
        notes: [`Poppler ${text.version ?? ''} concorda com o pdfjs (${referenceName})`],
      }
    : {
        problems: [
          `o Poppler diverge do pdfjs (${referenceName}) a partir do caractere ${diff.at}: Poppler "${clip(diff.a)}" × pdfjs "${clip(diff.b)}"`,
        ],
        notes: [],
      };
}

/** Run que é exatamente o marcador de bullet. */
const isBulletRun = (run: TextRun): boolean => run.text.trim() === '•';

export function checkContent(
  extracted: ExtractedPdf,
  expected: Expected,
  poppler: PopplerInput,
): CheckResult {
  const problems: string[] = [];
  let remaining = squash(extracted.streamText);
  // Blocos mais longos primeiro: um trecho curto nunca "consome" parte de um bloco maior.
  const blocks = expected.blocks
    .map((b) => ({ b, q: squash(b.text) }))
    .filter((x) => x.q !== '')
    .sort((x, y) => y.q.length - x.q.length);
  const missing: string[] = [];
  for (const { b, q } of blocks) {
    const at = remaining.indexOf(q);
    if (at < 0) {
      missing.push(`${b.id}: "${clip(b.text)}"`);
      continue;
    }
    remaining = `${remaining.slice(0, at)}\u0001${remaining.slice(at + q.length)}`;
  }
  if (missing.length > 0)
    problems.push(
      `${missing.length} bloco(s) esperado(s) ausente(s) ou alterado(s) no PDF: ${missing.slice(0, 5).join('; ')}`,
    );
  const extra = remaining.split('\u0001').filter((s) => s !== '');
  if (extra.length > 0)
    problems.push(
      `texto no PDF que não pertence ao currículo resolvido (${extra.join('').length} caracteres): ${extra
        .slice(0, 3)
        .map((s) => `"${clip(s)}"`)
        .join('; ')}`,
    );

  const bullets = extracted.runs.filter(isBulletRun).length;
  if (bullets !== expected.bullets)
    problems.push(`${bullets} marcador(es) "•" no PDF; o esperado eram ${expected.bullets}`);

  const cross = popplerComparison(
    poppler,
    (t) => t.raw,
    extracted.streamText,
    'ordem do fluxo de conteúdo',
  );
  problems.push(...cross.problems);
  return result(
    'H2',
    'conteúdo esperado × texto extraído (bidirecional)',
    problems,
    `${blocks.length} blocos esperados presentes, nenhum texto extra, ${bullets} bullets`,
    cross.notes,
  );
}

// ------------------------------------------------------------------ H3: ordem de leitura

function orderProblems(label: string, text: string, expected: Expected): string[] {
  const stream = squash(text);
  const problems: string[] = [];
  let pointer = 0;
  for (const block of expected.blocks) {
    const q = squash(block.text);
    if (q === '') continue;
    const at = stream.indexOf(q, pointer);
    if (at >= 0) {
      pointer = at + q.length;
    } else if (stream.includes(q)) {
      problems.push(
        `${label}: o bloco ${block.id} ("${clip(block.text, 40)}") aparece fora da ordem esperada`,
      );
    }
    // Bloco ausente é problema do H2 (conteúdo), não da ordem.
  }
  return problems;
}

export function checkReadingOrder(
  extracted: ExtractedPdf,
  expected: Expected,
  poppler: PopplerInput,
): CheckResult {
  const problems = [
    ...orderProblems('ordem do fluxo de conteúdo', extracted.streamText, expected).slice(0, 5),
    ...orderProblems(
      'ordem geométrica (de cima para baixo)',
      extracted.geometryText,
      expected,
    ).slice(0, 5),
  ];
  const cross = popplerComparison(
    poppler,
    (t) => t.reading,
    extracted.geometryText,
    'ordem de leitura geométrica',
  );
  problems.push(...cross.problems);
  return result(
    'H3',
    'ordem de leitura',
    problems,
    'blocos na ordem esperada no fluxo e na leitura geométrica',
    cross.notes,
  );
}

// ------------------------------------------------------------------ H4: links

/** Diferença entre dois multiconjuntos de strings. */
function multisetDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const count = new Map<string, number>();
  for (const x of b) count.set(x, (count.get(x) ?? 0) + 1);
  const onlyA: string[] = [];
  for (const x of a) {
    const left = count.get(x) ?? 0;
    if (left > 0) count.set(x, left - 1);
    else onlyA.push(x);
  }
  const onlyB = [...count].flatMap(([x, n]) => Array.from({ length: n }, () => x));
  return { onlyA, onlyB };
}

const URL_IN_TEXT = /https?:\/\/[^\s|]+/gu;

/** Tolerância (pt) da posição estimada da âncora: pelo menos 10 pt ou 25% da largura do link. */
const ANCHOR_MIN_TOLERANCE = 10;
const ANCHOR_RELATIVE_TOLERANCE = 0.25;

interface PositionedChar {
  char: string;
  x1: number;
  x2: number;
}

/**
 * Onde, na linha da âncora, está o texto esperado do link.
 *
 * O pdfjs não entrega a posição de cada letra e funde ou parte trechos em lugares que não coincidem com as
 * unidades desenhadas ("https:/" + "/www…"), então a posição de cada caractere é ESTIMADA dentro do trecho
 * (largura do trecho dividida pelos caracteres). Serve para pegar âncora trocada ou deslocada (os links de
 * uma linha ficam a dezenas de pontos um do outro), não para medir ao milímetro: por isso a tolerância.
 */
function estimateTextSpan(
  runs: TextRun[],
  anchor: LinkAnnotation,
  target: string,
): { x1: number; x2: number } | undefined {
  const [, y1, , y2] = anchor.rect;
  const band = runs
    .filter((r) => r.page === anchor.page && r.y >= y1 - 2 && r.y <= y2 + 2)
    .sort((a, b) => a.x - b.x);
  const chars: PositionedChar[] = [];
  for (const run of band) {
    const glyphs = Array.from(run.text);
    const step = run.width / Math.max(glyphs.length, 1);
    glyphs.forEach((char, i) => {
      if (!isIgnorableChar(char))
        chars.push({ char, x1: run.x + step * i, x2: run.x + step * (i + 1) });
    });
  }
  const line = chars.map((c) => c.char).join('');
  // Várias ocorrências (links repetidos): fica com a mais próxima da âncora.
  let best: { x1: number; x2: number } | undefined;
  let from = 0;
  for (;;) {
    const at = line.indexOf(target, from);
    if (at < 0) break;
    const first = chars[at];
    const last = chars[at + target.length - 1];
    if (first !== undefined && last !== undefined) {
      const span = { x1: first.x1, x2: last.x2 };
      if (
        best === undefined ||
        Math.abs(span.x1 - anchor.rect[0]) < Math.abs(best.x1 - anchor.rect[0])
      )
        best = span;
    }
    from = at + 1;
  }
  return best;
}

export function checkLinks(extracted: ExtractedPdf, expected: Expected): CheckResult {
  const problems: string[] = [];
  const expectedUrls = expected.links.map((l) => l.url);
  const annotations = extracted.annotations;

  for (const a of annotations) {
    if (a.url === undefined) problems.push(`anotação de link sem endereço (página ${a.page})`);
    else if (!/^https?:\/\//u.test(a.url))
      problems.push(`anotação com endereço fora de http(s): "${clip(a.url, 50)}"`);
  }
  const annotated = annotations.flatMap((a) => (a.url === undefined ? [] : [a.url]));
  // URLs visíveis: lidas das LINHAS (o pdfjs pode partir uma URL em vários trechos, nunca em linhas).
  const visible = extracted.streamText.split('\n').flatMap((line) => line.match(URL_IN_TEXT) ?? []);

  const compare = (a: string[], b: string[], onlyA: string, onlyB: string): void => {
    const d = multisetDiff(a, b);
    if (d.onlyA.length > 0)
      problems.push(`${onlyA}: ${d.onlyA.map((u) => clip(u, 70)).join(', ')}`);
    if (d.onlyB.length > 0)
      problems.push(`${onlyB}: ${d.onlyB.map((u) => clip(u, 70)).join(', ')}`);
  };
  compare(
    expectedUrls,
    annotated,
    'link esperado sem anotação clicável',
    'anotação clicável a mais (link não esperado)',
  );
  compare(
    expectedUrls,
    visible,
    'URL esperada que não está visível no texto',
    'URL visível a mais (não esperada)',
  );
  compare(
    visible,
    annotated,
    'URL visível sem anotação clicável',
    'anotação clicável sem URL visível',
  );

  // A âncora clicável precisa ficar sobre o texto impresso daquele link ("Rótulo: endereço").
  const pending = expected.links.map((l) => ({ ...l, used: false }));
  for (const a of annotations) {
    if (a.url === undefined) continue;
    const want = pending.find((l) => !l.used && l.url === a.url);
    if (want === undefined) continue; // link a mais: já relatado acima
    want.used = true;
    const span = estimateTextSpan(extracted.runs, a, squash(want.text));
    if (span === undefined) {
      problems.push(
        `o texto "${clip(want.text)}" não está na linha onde a área clicável foi desenhada`,
      );
      continue;
    }
    const width = span.x2 - span.x1;
    const tolerance = Math.max(ANCHOR_MIN_TOLERANCE, ANCHOR_RELATIVE_TOLERANCE * width);
    if (Math.abs(span.x1 - a.rect[0]) > tolerance || Math.abs(span.x2 - a.rect[2]) > tolerance)
      problems.push(
        `a área clicável de ${clip(a.url, 50)} (x ${a.rect[0].toFixed(0)}–${a.rect[2].toFixed(0)}) não coincide com onde o texto do link está (x ${span.x1.toFixed(0)}–${span.x2.toFixed(0)})`,
      );
  }
  return result(
    'H4',
    'URLs visíveis, anotações clicáveis e ausência de links extras',
    problems,
    `${expectedUrls.length} link(s): visíveis, clicáveis e sobre o texto certo, sem extras`,
  );
}
