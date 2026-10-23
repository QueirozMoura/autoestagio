import { CMapError, parseToUnicode, type CMap } from './cmap.js';
import {
  DEFAULT_LIMITS,
  PdfParser,
  PdfStructureError,
  deref,
  dictOf,
  isDict,
  isPdfString,
  nameOf,
  isRef,
  objectOf,
  readPageNodes,
  streamBytes,
  type PageNode,
  type PdfDict,
  type PdfStructure,
  type PdfValue,
  type StructureLimits,
} from './pdf-objects.js';

/**
 * Intérprete ESTRITO do fluxo de conteúdo de uma página, só para o subconjunto que o nosso PDFKit usa.
 *
 * Em vez de confiar no que o pdfjs ou o Poppler extraem, lê os operadores: compõe a pilha de matrizes, acompanha
 * fonte, tamanho, cor e posição e decodifica o texto de cada `TJ` pelo `ToUnicode`. Qualquer operador fora da
 * lista de permissão é recusado pelo nome (falha fechada); se o PDFKit passar a usar outro, a validação aponta
 * exatamente qual. Não há operador de imagem, de clipping nem de preenchimento: nada pode cobrir ou esconder texto.
 */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Produto `a × b` (aplica `a` primeiro): convenção de linha dos PDFs. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  x * m[0] + y * m[2] + m[4],
  x * m[1] + y * m[3] + m[5],
];

export class ContentStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentStreamError';
  }
}

// ------------------------------------------------------------------ operadores permitidos

export interface ContentOp {
  op: string;
  operands: PdfValue[];
  /** Posição do operador na sequência (para as mensagens). */
  index: number;
}

type OperandCheck = (operands: PdfValue[]) => string | undefined;
const numbers =
  (min: number, max = min): OperandCheck =>
  (o) =>
    o.length >= min && o.length <= max && o.every((x) => typeof x === 'number')
      ? undefined
      : `esperava ${min === max ? min : `${min} a ${max}`} número(s)`;
const oneName: OperandCheck = (o) =>
  o.length === 1 && nameOf(o[0]) !== undefined ? undefined : 'esperava um nome';

/** Espaços de cor aceitos (os de dispositivo) e quantos componentes cada um tem. */
const COLOR_SPACES: Record<string, number> = { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4 };

export const ALLOWED_OPERATORS: Record<string, OperandCheck> = {
  q: numbers(0),
  Q: numbers(0),
  cm: numbers(6),
  BT: numbers(0),
  ET: numbers(0),
  Tm: numbers(6),
  Tf: (o) =>
    o.length === 2 && nameOf(o[0]) !== undefined && typeof o[1] === 'number'
      ? undefined
      : 'esperava nome e número',
  TJ: (o) =>
    o.length === 1 &&
    Array.isArray(o[0]) &&
    o[0].every((e) => typeof e === 'number' || isPdfString(e))
      ? undefined
      : 'esperava um array de strings e números',
  Tc: numbers(1),
  cs: oneName,
  CS: oneName,
  scn: numbers(1, 4),
  SCN: numbers(1, 4),
  BDC: (o) =>
    o.length === 2 && nameOf(o[0]) !== undefined && (isDict(o[1]) || nameOf(o[1]) !== undefined)
      ? undefined
      : 'esperava nome e propriedades',
  EMC: numbers(0),
  m: numbers(2),
  l: numbers(2),
  w: numbers(1),
  S: numbers(0),
};

const MAX_OPERANDS = 64;

/** Quebra o fluxo em operadores com seus operandos. Para no primeiro `BI` (os dados seguintes são binários). */
export function tokenizeContent(
  source: string,
  limits: StructureLimits = DEFAULT_LIMITS,
): { ops: ContentOp[]; stoppedAt?: string } {
  const parser = new PdfParser(source, limits, false);
  const ops: ContentOp[] = [];
  let operands: PdfValue[] = [];
  const valueStart = new RegExp('[\\[(</\\d+\\-.]', 'u');
  for (;;) {
    parser.skipWhite();
    const c = source[parser.pos];
    if (c === undefined) break;
    if (valueStart.test(c)) {
      try {
        operands.push(parser.value(0));
      } catch (error) {
        throw new ContentStreamError(error instanceof Error ? error.message : String(error));
      }
      if (operands.length > MAX_OPERANDS)
        throw new ContentStreamError('operandos demais antes de um operador');
      continue;
    }
    const word = /^[^\s()<>[\]{}/%]+/u.exec(source.slice(parser.pos, parser.pos + 40))?.[0];
    if (word === undefined)
      throw new ContentStreamError(`caractere inesperado "${c}" (posição ${parser.pos})`);
    parser.pos += word.length;
    parser.tokens += 1;
    if (parser.tokens > limits.maxTokensPerObject * 10)
      throw new ContentStreamError('fluxo de conteúdo grande demais');
    if (word === 'true' || word === 'false' || word === 'null') {
      operands.push(word === 'null' ? null : word === 'true');
      continue;
    }
    ops.push({ op: word, operands, index: ops.length });
    operands = [];
    if (word === 'BI') return { ops, stoppedAt: 'BI' };
  }
  if (operands.length > 0) throw new ContentStreamError('operandos sem operador no fim do fluxo');
  return { ops };
}

// ------------------------------------------------------------------ fontes do recurso

export interface FontResource {
  /** Nome no recurso (ex.: F2). */
  name: string;
  baseFont?: string;
  encoding?: string;
  toUnicode?: CMap;
  /** Largura de um CID em milésimos do corpo (usa /W e /DW; padrão 1000). */
  width: (cid: number) => number;
}

/** Larguras do `/W` de uma fonte CID: `c [w1 w2 …]` e `c1 c2 w`. */
function widthLookup(
  structure: PdfStructure,
  cidFont: PdfDict | undefined,
): (cid: number) => number {
  const dw = deref(structure, cidFont?.map.get('DW'));
  const fallback = typeof dw === 'number' ? dw : 1000;
  const table = new Map<number, number>();
  const ranges: [number, number, number][] = [];
  const raw = deref(structure, cidFont?.map.get('W'));
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length;) {
      const first = deref(structure, raw[i]);
      const second = deref(structure, raw[i + 1]);
      if (typeof first !== 'number') break;
      if (Array.isArray(second)) {
        second.forEach((w, k) => {
          const v = deref(structure, w);
          if (typeof v === 'number') table.set(first + k, v);
        });
        i += 2;
      } else {
        const width = deref(structure, raw[i + 2]);
        if (typeof second === 'number' && typeof width === 'number')
          ranges.push([first, second, width]);
        i += 3;
      }
    }
  }
  return (cid) => {
    const direct = table.get(cid);
    if (direct !== undefined) return direct;
    const range = ranges.find(([lo, hi]) => cid >= lo && cid <= hi);
    return range === undefined ? fallback : range[2];
  };
}

/** Fontes do `/Resources /Font` de uma página, com `ToUnicode` e larguras; problemas viram mensagens. */
export function readFontResources(
  structure: PdfStructure,
  resources: PdfDict | undefined,
): { fonts: Map<string, FontResource>; problems: string[] } {
  const fonts = new Map<string, FontResource>();
  const problems: string[] = [];
  const dict = dictOf(structure, resources?.map.get('Font'));
  for (const [name, ref] of dict?.map ?? []) {
    const font = dictOf(structure, ref);
    if (font === undefined) {
      problems.push(`recurso de fonte /${name} inválido`);
      continue;
    }
    const descendants = deref(structure, font.map.get('DescendantFonts'));
    const cid = Array.isArray(descendants) ? dictOf(structure, descendants[0]) : undefined;
    let toUnicode: CMap | undefined;
    const object = objectOf(structure, font.map.get('ToUnicode'));
    if (object !== undefined) {
      try {
        toUnicode = parseToUnicode(streamBytes(structure, object).toString('latin1'));
      } catch (error) {
        problems.push(
          `ToUnicode da fonte /${name} ilegível: ${error instanceof CMapError || error instanceof PdfStructureError ? error.message : String(error)}`,
        );
      }
    }
    const baseFont = nameOf(font.map.get('BaseFont'));
    const encoding = nameOf(deref(structure, font.map.get('Encoding')));
    fonts.set(name, {
      name,
      ...(baseFont === undefined ? {} : { baseFont }),
      ...(encoding === undefined ? {} : { encoding }),
      ...(toUnicode === undefined ? {} : { toUnicode }),
      width: widthLookup(structure, cid),
    });
  }
  return { fonts, problems };
}

// ------------------------------------------------------------------ interpretação

export interface TextShow {
  font: string;
  /** Tamanho nominal do `Tf` e tamanho efetivo na página (com as matrizes). */
  nominalSize: number;
  size: number;
  /** Origem do texto em coordenadas da página. */
  origin: [number, number];
  /** Caixa envolvente estimada, em coordenadas da página. */
  bbox: [number, number, number, number];
  text: string;
  /** CIDs sem mapeamento no ToUnicode (viram U+FFFD no texto). */
  unmapped: number;
  fill: { space: string; components: number[] };
  nearWhite: boolean;
  /** A caixa não toca a página: o texto não é visível. */
  outside: boolean;
}

export interface ContentAnalysis {
  shows: TextShow[];
  operators: Map<string, number>;
  problems: string[];
  /** Texto decodificado de todos os `TJ`, na ordem do fluxo. */
  text: string;
  /** CIDs desenhados por fonte (nome no recurso), para conferir a cobertura do ToUnicode. */
  usage: Map<string, Set<number>>;
}

export interface AnalyzeContext {
  fonts: Map<string, FontResource>;
  /** Caixa visível da página: [x1, y1, x2, y2]. */
  pageBox: [number, number, number, number];
  limits?: StructureLimits;
}

interface GraphicsState {
  ctm: Matrix;
  font: string | undefined;
  fontSize: number;
  charSpacing: number;
  fillSpace: string;
  fillComponents: number[];
  strokeSpace: string;
}

/** Branco (ou quase): invisível sobre a página branca. */
export function isNearWhite(space: string, components: number[]): boolean {
  if (space === 'DeviceRGB') return components.length === 3 && components.every((c) => c > 0.9);
  if (space === 'DeviceGray') return (components[0] ?? 0) > 0.9;
  if (space === 'DeviceCMYK') return components.length === 4 && components.every((c) => c <= 0.05);
  return false;
}

const MAX_PROBLEMS = 40;

export function analyzeContent(stream: Buffer, context: AnalyzeContext): ContentAnalysis {
  const problems: string[] = [];
  const report = (message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
  };
  const operators = new Map<string, number>();
  const shows: TextShow[] = [];
  const usage = new Map<string, Set<number>>();
  let text = '';

  let tokens: { ops: ContentOp[]; stoppedAt?: string };
  try {
    tokens = tokenizeContent(stream.toString('latin1'), context.limits);
  } catch (error) {
    return {
      shows,
      operators,
      problems: [
        `fluxo de conteúdo ilegível: ${error instanceof Error ? error.message : String(error)}`,
      ],
      text,
      usage,
    };
  }
  if (tokens.stoppedAt !== undefined)
    report(`operador "${tokens.stoppedAt}" (imagem em linha) não é permitido`);

  const initial = (): GraphicsState => ({
    ctm: IDENTITY,
    font: undefined,
    fontSize: 0,
    charSpacing: 0,
    fillSpace: 'DeviceGray',
    fillComponents: [0],
    strokeSpace: 'DeviceGray',
  });
  let state = initial();
  const stack: GraphicsState[] = [];
  let inText = false;
  let tm: Matrix = IDENTITY;
  let markedDepth = 0;
  let pathOpen = false;
  const [px1, py1, px2, py2] = context.pageBox;

  for (const { op, operands, index } of tokens.ops) {
    operators.set(op, (operators.get(op) ?? 0) + 1);
    const check = ALLOWED_OPERATORS[op];
    const where = `operador #${index + 1} "${op}"`;
    if (check === undefined) {
      report(`${where} não está na lista de permissão`);
      continue;
    }
    const bad = check(operands);
    if (bad !== undefined) {
      report(`${where} com operandos inválidos: ${bad}`);
      continue;
    }
    const n = (i: number): number => (typeof operands[i] === 'number' ? operands[i] : 0);
    switch (op) {
      case 'q':
        if (inText) report(`${where} dentro de um objeto de texto`);
        stack.push({ ...state, fillComponents: [...state.fillComponents] });
        if (stack.length > 32) report('pilha de estados gráficos funda demais');
        break;
      case 'Q': {
        if (inText) report(`${where} dentro de um objeto de texto`);
        const previous = stack.pop();
        if (previous === undefined) report(`${where} sem "q" correspondente`);
        else state = previous;
        break;
      }
      case 'cm':
        if (inText) report(`${where} dentro de um objeto de texto`);
        state.ctm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], state.ctm);
        break;
      case 'BT':
        if (inText) report(`${where} aninhado`);
        inText = true;
        tm = IDENTITY;
        break;
      case 'ET':
        if (!inText) report(`${where} sem "BT"`);
        inText = false;
        break;
      case 'Tm':
        if (!inText) report(`${where} fora de um objeto de texto`);
        tm = [n(0), n(1), n(2), n(3), n(4), n(5)];
        break;
      case 'Tf': {
        const name = nameOf(operands[0]) ?? '';
        if (!context.fonts.has(name))
          report(`${where}: a fonte /${name} não existe nos recursos da página`);
        state.font = name;
        state.fontSize = n(1);
        break;
      }
      case 'Tc':
        state.charSpacing = n(0);
        break;
      case 'cs':
      case 'CS': {
        const space = nameOf(operands[0]) ?? '';
        if (COLOR_SPACES[space] === undefined) {
          report(`${where}: espaço de cor /${space} não permitido (só os de dispositivo)`);
          break;
        }
        if (op === 'cs') {
          state.fillSpace = space;
          state.fillComponents = Array.from({ length: COLOR_SPACES[space] ?? 1 }, () => 0);
        } else state.strokeSpace = space;
        break;
      }
      case 'scn':
      case 'SCN': {
        const space = op === 'scn' ? state.fillSpace : state.strokeSpace;
        const expected = COLOR_SPACES[space] ?? 0;
        const values = operands.filter((x): x is number => typeof x === 'number');
        if (values.length !== expected)
          report(
            `${where}: ${values.length} componente(s) de cor para ${space} (esperava ${expected})`,
          );
        else if (values.some((v) => v < 0 || v > 1))
          report(`${where}: componente de cor fora de [0, 1]`);
        else if (op === 'scn') state.fillComponents = values;
        break;
      }
      case 'BDC': {
        markedDepth += 1;
        const props = operands[1];
        if (isDict(props) && [...props.map.keys()].some((k) => k !== 'MCID'))
          report(`${where}: propriedades de conteúdo marcado inesperadas`);
        if (markedDepth > 8) report('conteúdo marcado aninhado demais');
        break;
      }
      case 'EMC':
        if (markedDepth === 0) report(`${where} sem "BDC" correspondente`);
        else markedDepth -= 1;
        break;
      case 'm':
      case 'l':
        if (inText) report(`${where} dentro de um objeto de texto`);
        pathOpen = true;
        break;
      case 'w':
        break;
      case 'S':
        if (!pathOpen) report(`${where} sem caminho para traçar`);
        pathOpen = false;
        break;
      case 'TJ': {
        if (!inText) {
          report(`${where} fora de um objeto de texto`);
          break;
        }
        const font = state.font === undefined ? undefined : context.fonts.get(state.font);
        if (font === undefined) {
          report(`${where}: nenhuma fonte válida selecionada`);
          break;
        }
        if (font.encoding !== 'Identity-H') {
          report(
            `${where}: a fonte /${font.name} usa a codificação ${font.encoding ?? '(ausente)'}, e só Identity-H é suportada`,
          );
          break;
        }
        const array = Array.isArray(operands[0]) ? operands[0] : [];
        const size = state.fontSize;
        let decoded = '';
        let unmapped = 0;
        let advance = 0; // em unidades do espaço de texto
        for (const element of array) {
          if (typeof element === 'number') {
            advance -= (element / 1000) * size;
          } else if (isPdfString(element)) {
            const bytes = element.bytes;
            if (bytes.length % 2 !== 0) {
              report(`${where}: string com número ímpar de bytes (CID de 2 bytes esperado)`);
              continue;
            }
            for (let i = 0; i < bytes.length; i += 2) {
              const cid = ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0);
              const used = usage.get(font.name) ?? new Set<number>();
              used.add(cid);
              usage.set(font.name, used);
              const mapped = font.toUnicode?.map.get(cid);
              if (mapped === undefined) {
                unmapped += 1;
                decoded += '�';
              } else decoded += mapped;
              advance += (font.width(cid) / 1000) * size + state.charSpacing;
            }
          }
        }
        const trm = multiply(tm, state.ctm);
        const scale = Math.sqrt(Math.abs(trm[0] * trm[3] - trm[1] * trm[2]));
        const corners = [
          apply(trm, 0, -0.3 * size),
          apply(trm, advance, -0.3 * size),
          apply(trm, 0, size),
          apply(trm, advance, size),
        ];
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const bbox: [number, number, number, number] = [
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
        ];
        const effective = size * scale;
        const outside = bbox[2] < px1 || bbox[0] > px2 || bbox[3] < py1 || bbox[1] > py2;
        const show: TextShow = {
          font: font.name,
          nominalSize: size,
          size: effective,
          origin: apply(trm, 0, 0),
          bbox,
          text: decoded,
          unmapped,
          fill: { space: state.fillSpace, components: [...state.fillComponents] },
          nearWhite: isNearWhite(state.fillSpace, state.fillComponents),
          outside,
        };
        shows.push(show);
        text += decoded;
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
        break;
      }
      default:
        break;
    }
  }
  if (inText) report('objeto de texto "BT" sem "ET" no fim do fluxo');
  if (stack.length > 0) report(`${stack.length} "q" sem "Q" no fim do fluxo`);
  if (markedDepth > 0) report(`${markedDepth} "BDC" sem "EMC" no fim do fluxo`);
  if (pathOpen) report('caminho sem traçado ("S") no fim do fluxo');
  return { shows, operators, problems, text, usage };
}

// ------------------------------------------------------------------ páginas inteiras

export interface PageAnalysis {
  /** Número da página (1 = primeira). */
  number: number;
  node: PageNode;
  fonts: Map<string, FontResource>;
  /** Problemas ao ler o conteúdo da página, as fontes e os operadores. */
  contentProblems: string[];
  fontProblems: string[];
  /** Ausente quando a página não tem MediaBox para conferir o texto. */
  analysis?: ContentAnalysis;
}

/** Bytes do fluxo de conteúdo de uma página (vários fluxos são concatenados, como manda o PDF). */
export function readPageContent(
  structure: PdfStructure,
  node: PageNode,
): { bytes: Buffer; problems: string[] } {
  const problems: string[] = [];
  const value = node.dict.map.get('Contents');
  const resolved = deref(structure, value);
  const refs = Array.isArray(resolved) && !isRef(value) ? resolved : [value];
  const chunks: Buffer[] = [];
  for (const ref of refs) {
    const object = isRef(ref) ? structure.objects.get(ref.num) : undefined;
    if (object?.stream === undefined) {
      problems.push('/Contents não é um fluxo');
      continue;
    }
    try {
      chunks.push(streamBytes(structure, object), Buffer.from('\n'));
    } catch (error) {
      problems.push(
        `fluxo de conteúdo ilegível (${error instanceof PdfStructureError ? error.message : String(error)})`,
      );
    }
  }
  return { bytes: Buffer.concat(chunks), problems };
}

/** Lê e interpreta o conteúdo de cada página (uma vez), com as fontes dos recursos. */
export function analyzePages(structure: PdfStructure): {
  pages: PageAnalysis[];
  problems: string[];
} {
  let nodes: PageNode[];
  try {
    nodes = readPageNodes(structure);
  } catch (error) {
    return {
      pages: [],
      problems: [
        `páginas ilegíveis: ${error instanceof PdfStructureError ? error.message : String(error)}`,
      ],
    };
  }
  const pages = nodes.map((node, index): PageAnalysis => {
    const content = readPageContent(structure, node);
    const contentProblems = [...content.problems];
    const { fonts, problems: fontProblems } = readFontResources(structure, node.resources);
    const box = node.mediaBox;
    if (box === undefined || box.length !== 4) {
      contentProblems.push('sem MediaBox para conferir o texto');
      return { number: index + 1, node, fonts, contentProblems, fontProblems };
    }
    const analysis = analyzeContent(content.bytes, {
      fonts,
      pageBox: [box[0] ?? 0, box[1] ?? 0, box[2] ?? 0, box[3] ?? 0],
      limits: structure.limits,
    });
    return { number: index + 1, node, fonts, contentProblems, fontProblems, analysis };
  });
  return { pages, problems: [] };
}
