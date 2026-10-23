import { inflateSync } from 'node:zlib';

/**
 * Leitor estrutural MÍNIMO de PDF, somente para PDFs gerados pelo nosso PDFKit (tabela de referências
 * clássica, sem object streams, sem criptografia, sem atualização incremental). Serve às verificações de
 * segurança (metadados, geometria…); o texto continua vindo do pdfjs.
 *
 * Falha FECHADA: qualquer estrutura fora disso (ou acima dos limites) lança `PdfStructureError` e a validação
 * correspondente falha; nunca se "pula" o que não foi possível ler. Opera só em memória.
 */
export type StructureErrorCode =
  'TOO_LARGE' | 'TOO_MANY_OBJECTS' | 'TOO_DEEP' | 'MALFORMED' | 'UNSUPPORTED';

export class PdfStructureError extends Error {
  constructor(
    readonly code: StructureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PdfStructureError';
  }
}

export interface StructureLimits {
  /** Tamanho máximo do arquivo. */
  maxBytes: number;
  maxObjects: number;
  /** Profundidade máxima de dicionários/arrays aninhados (e da árvore de páginas). */
  maxDepth: number;
  maxTokensPerObject: number;
  /** Tamanho máximo de um fluxo depois de descomprimido. */
  maxDecodedStreamBytes: number;
}

export const DEFAULT_LIMITS: StructureLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxObjects: 10_000,
  maxDepth: 16,
  maxTokensPerObject: 200_000,
  maxDecodedStreamBytes: 4 * 1024 * 1024,
};

export interface PdfName {
  kind: 'name';
  value: string;
}
export interface PdfRef {
  kind: 'ref';
  num: number;
  gen: number;
}
export interface PdfString {
  kind: 'string';
  bytes: Buffer;
}
export interface PdfDict {
  kind: 'dict';
  map: Map<string, PdfValue>;
}
export type PdfValue =
  PdfName | PdfRef | PdfString | PdfDict | PdfValue[] | number | boolean | null;

export interface PdfObject {
  num: number;
  gen: number;
  value: PdfValue;
  /** Bytes do fluxo, ainda codificados (use `streamBytes`). */
  stream?: Buffer;
}

export interface PdfStructure {
  objects: Map<number, PdfObject>;
  trailer: PdfDict;
  limits: StructureLimits;
}

const isWhite = (c: string): boolean =>
  c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
const isDelimiter = (c: string): boolean => '()<>[]{}/%'.includes(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';

/** Analisador de valores PDF (também usado nos fluxos de conteúdo, onde "N G R" não é referência). */
export class PdfParser {
  pos = 0;
  tokens = 0;
  constructor(
    readonly src: string,
    readonly limits: StructureLimits,
    readonly allowRefs = true,
  ) {}

  fail(message: string, code: StructureErrorCode = 'MALFORMED'): never {
    throw new PdfStructureError(code, `${message} (posição ${this.pos})`);
  }

  skipWhite(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) return;
      if (isWhite(c)) this.pos += 1;
      else if (c === '%') {
        while (
          this.pos < this.src.length &&
          this.src[this.pos] !== '\n' &&
          this.src[this.pos] !== '\r'
        )
          this.pos += 1;
      } else return;
    }
  }

  count(): void {
    this.tokens += 1;
    if (this.tokens > this.limits.maxTokensPerObject)
      this.fail('objeto com tokens demais', 'TOO_LARGE');
  }

  value(depth: number): PdfValue {
    if (depth > this.limits.maxDepth) this.fail('estrutura aninhada demais', 'TOO_DEEP');
    this.skipWhite();
    this.count();
    const c = this.src[this.pos];
    if (c === undefined) return this.fail('fim inesperado do arquivo');
    if (c === '<' && this.src[this.pos + 1] === '<') return this.dict(depth);
    if (c === '<') return this.hexString();
    if (c === '(') return this.literalString();
    if (c === '[') return this.array(depth);
    if (c === '/') return { kind: 'name', value: this.name() };
    if (isDigit(c) || c === '-' || c === '+' || c === '.') return this.numberOrRef();
    for (const word of ['true', 'false', 'null'] as const) {
      if (
        this.src.startsWith(word, this.pos) &&
        isDelimiterOrEnd(this.src[this.pos + word.length])
      ) {
        this.pos += word.length;
        return word === 'null' ? null : word === 'true';
      }
    }
    return this.fail(`token inesperado "${c}"`);
  }

  dict(depth: number): PdfDict {
    this.pos += 2;
    const map = new Map<string, PdfValue>();
    for (;;) {
      this.skipWhite();
      if (this.src.startsWith('>>', this.pos)) {
        this.pos += 2;
        return { kind: 'dict', map };
      }
      if (this.src[this.pos] !== '/') this.fail('chave de dicionário inválida');
      const key = this.name();
      if (map.has(key)) this.fail(`chave duplicada /${key}`);
      map.set(key, this.value(depth + 1));
    }
  }

  array(depth: number): PdfValue[] {
    this.pos += 1;
    const items: PdfValue[] = [];
    for (;;) {
      this.skipWhite();
      if (this.src[this.pos] === ']') {
        this.pos += 1;
        return items;
      }
      items.push(this.value(depth + 1));
    }
  }

  name(): string {
    this.pos += 1;
    let out = '';
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined || isWhite(c) || isDelimiter(c)) return out;
      if (c === '#') {
        const hex = this.src.slice(this.pos + 1, this.pos + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('escape inválido em nome');
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 3;
      } else {
        out += c;
        this.pos += 1;
      }
    }
  }

  hexString(): PdfString {
    const end = this.src.indexOf('>', this.pos);
    if (end < 0) this.fail('string hexadecimal não fechada');
    const hex = this.src.slice(this.pos + 1, end).replace(/\s+/g, '');
    if (!/^[0-9a-fA-F]*$/.test(hex)) this.fail('string hexadecimal inválida');
    this.pos = end + 1;
    return { kind: 'string', bytes: Buffer.from(hex.length % 2 === 1 ? `${hex}0` : hex, 'hex') };
  }

  literalString(): PdfString {
    this.pos += 1;
    const out: number[] = [];
    let depth = 1;
    for (;;) {
      const c = this.src[this.pos];
      if (c === undefined) return this.fail('string não fechada');
      this.pos += 1;
      if (c === '\\') {
        const n = this.src[this.pos];
        if (n === undefined) return this.fail('escape no fim do arquivo');
        this.pos += 1;
        const simple: Record<string, number> = {
          n: 10,
          r: 13,
          t: 9,
          b: 8,
          f: 12,
          '(': 40,
          ')': 41,
          '\\': 92,
        };
        if (n in simple) out.push(simple[n] ?? 0);
        else if (n >= '0' && n <= '7') {
          let digits = n;
          while (
            digits.length < 3 &&
            this.src[this.pos] !== undefined &&
            /[0-7]/.test(this.src[this.pos] ?? '')
          ) {
            digits += this.src[this.pos] ?? '';
            this.pos += 1;
          }
          out.push(parseInt(digits, 8) & 0xff);
        } else if (n === '\r') {
          if (this.src[this.pos] === '\n') this.pos += 1;
        } else if (n !== '\n') out.push(n.charCodeAt(0) & 0xff);
        continue;
      }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) return { kind: 'string', bytes: Buffer.from(out) };
      }
      out.push(c.charCodeAt(0) & 0xff);
    }
  }

  numberOrRef(): number | PdfRef {
    const start = this.pos;
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(this.src.slice(this.pos, this.pos + 40));
    if (match === null) return this.fail('número inválido');
    this.pos += match[0].length;
    const first = Number(match[0]);
    if (this.allowRefs && /^\d+$/.test(match[0])) {
      const rest = /^\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(this.src.slice(this.pos, this.pos + 40));
      if (rest !== null) {
        this.pos += rest[0].length;
        return { kind: 'ref', num: first, gen: Number(rest[1]) };
      }
    }
    if (!Number.isFinite(first)) {
      this.pos = start;
      return this.fail('número fora do intervalo');
    }
    return first;
  }
}

function isDelimiterOrEnd(c: string | undefined): boolean {
  return c === undefined || isWhite(c) || isDelimiter(c);
}

/** Lê a estrutura do PDF (somente em memória). Lança `PdfStructureError` se algo fugir do esperado. */
export function readPdfStructure(
  bytes: Buffer,
  limitOverrides: Partial<StructureLimits> = {},
): PdfStructure {
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  if (bytes.length > limits.maxBytes)
    throw new PdfStructureError(
      'TOO_LARGE',
      `arquivo com ${bytes.length} bytes; o limite é ${limits.maxBytes}`,
    );
  const src = bytes.toString('latin1');
  if (!src.startsWith('%PDF-')) throw new PdfStructureError('MALFORMED', 'sem o cabeçalho %PDF-');

  const objects = new Map<number, PdfObject>();
  const finder = /(?<![0-9])(\d{1,10}) (\d{1,5}) obj(?![A-Za-z])/g;
  let lastEnd = 0;
  for (;;) {
    finder.lastIndex = lastEnd;
    const match = finder.exec(src);
    if (match === null) break;
    // Objeto depois da tabela de referências = atualização incremental ou conteúdo anexado.
    if (/(?:^|\n)xref\r?\n/u.test(src.slice(lastEnd, match.index)))
      throw new PdfStructureError(
        'UNSUPPORTED',
        'objetos depois da tabela de referências (atualização incremental)',
      );
    if (objects.size >= limits.maxObjects)
      throw new PdfStructureError('TOO_MANY_OBJECTS', `mais de ${limits.maxObjects} objetos`);
    const parser = new PdfParser(src, limits);
    parser.pos = match.index + match[0].length;
    const num = Number(match[1]);
    const value = parser.value(0);
    parser.skipWhite();
    let stream: Buffer | undefined;
    if (src.startsWith('stream', parser.pos)) {
      if (!isDict(value)) throw new PdfStructureError('MALFORMED', 'fluxo sem dicionário');
      let start = parser.pos + 'stream'.length;
      if (src[start] === '\r' && src[start + 1] === '\n') start += 2;
      else if (src[start] === '\n') start += 1;
      else parser.fail('"stream" sem quebra de linha');
      const declared = value.map.get('Length');
      let end = -1;
      if (typeof declared === 'number' && declared >= 0 && start + declared <= src.length) {
        const tail = src.slice(start + declared, start + declared + 12);
        if (/^\r?\n?endstream/.test(tail)) end = start + declared;
      }
      if (end < 0) {
        const found = src.indexOf('endstream', start);
        if (found < 0) parser.fail('fluxo sem "endstream"');
        end = found;
        if (src[end - 1] === '\n') end -= 1;
        if (src[end - 1] === '\r') end -= 1;
      }
      stream = Buffer.from(src.slice(start, end), 'latin1');
      parser.pos = src.indexOf('endstream', end) + 'endstream'.length;
      parser.skipWhite();
    }
    if (!src.startsWith('endobj', parser.pos)) parser.fail(`objeto ${num} sem "endobj"`);
    lastEnd = parser.pos + 'endobj'.length;
    if (objects.has(num)) throw new PdfStructureError('MALFORMED', `objeto ${num} repetido`);
    objects.set(num, {
      num,
      gen: Number(match[2]),
      value,
      ...(stream === undefined ? {} : { stream }),
    });
  }
  if (objects.size === 0) throw new PdfStructureError('MALFORMED', 'nenhum objeto encontrado');

  // O que vem depois do último objeto: exatamente a tabela de referências, o trailer, startxref e %%EOF.
  const tail = src.slice(lastEnd);
  const xrefAt = lastEnd + tail.indexOf('xref');
  const shape = /^\s*xref\s[\s\S]*?\btrailer\s*(<<[\s\S]*>>)\s*startxref\s+(\d+)\s+%%EOF\s*$/.exec(
    tail,
  );
  if (shape === null || tail.indexOf('xref') < 0)
    throw new PdfStructureError(
      'UNSUPPORTED',
      'conteúdo fora do esperado depois dos objetos (atualização incremental, dados após %%EOF ou tabela ausente)',
    );
  if (tail.split('startxref').length !== 2 || tail.split('%%EOF').length !== 2)
    throw new PdfStructureError('UNSUPPORTED', 'mais de um startxref ou %%EOF');
  if (Number(shape[2]) !== xrefAt)
    throw new PdfStructureError('MALFORMED', 'startxref não aponta para a tabela de referências');
  const trailerParser = new PdfParser(src, limits);
  trailerParser.pos = lastEnd + (shape.index + shape[0].indexOf(shape[1] ?? ''));
  const trailer = trailerParser.value(0);
  if (!isDict(trailer)) throw new PdfStructureError('MALFORMED', 'trailer inválido');
  if (trailer.map.has('Encrypt')) throw new PdfStructureError('UNSUPPORTED', 'PDF criptografado');
  if (trailer.map.has('Prev'))
    throw new PdfStructureError('UNSUPPORTED', 'atualização incremental (/Prev)');

  for (const object of objects.values()) {
    if (isDict(object.value)) {
      const type = nameOf(object.value.map.get('Type'));
      if (type === 'ObjStm' || type === 'XRef')
        throw new PdfStructureError(
          'UNSUPPORTED',
          `objeto ${object.num} do tipo /${type} (object streams não são suportados)`,
        );
    }
  }
  return { objects, trailer, limits };
}

// ------------------------------------------------------------------ utilidades de leitura

export const isDict = (value: PdfValue | undefined): value is PdfDict =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'kind' in value &&
  value.kind === 'dict';
export const isRef = (value: PdfValue | undefined): value is PdfRef =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'kind' in value &&
  value.kind === 'ref';
export const isPdfString = (value: PdfValue | undefined): value is PdfString =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'kind' in value &&
  value.kind === 'string';
export const nameOf = (value: PdfValue | undefined): string | undefined =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'kind' in value &&
  value.kind === 'name'
    ? value.value
    : undefined;

/** Segue referências (com proteção contra ciclos). */
export function deref(structure: PdfStructure, value: PdfValue | undefined): PdfValue | undefined {
  let current = value;
  for (let hops = 0; hops < structure.limits.maxDepth; hops++) {
    if (!isRef(current)) return current;
    current = structure.objects.get(current.num)?.value;
  }
  throw new PdfStructureError('TOO_DEEP', 'cadeia de referências longa demais (ciclo?)');
}

export function dictOf(structure: PdfStructure, value: PdfValue | undefined): PdfDict | undefined {
  const resolved = deref(structure, value);
  return isDict(resolved) ? resolved : undefined;
}

export function objectOf(
  structure: PdfStructure,
  value: PdfValue | undefined,
): PdfObject | undefined {
  return isRef(value) ? structure.objects.get(value.num) : undefined;
}

/** Texto de uma string do PDF: UTF-16BE (com BOM) ou PDFDocEncoding (aproximado por Latin-1). */
export function decodeText(value: PdfString): string {
  const b = value.bytes;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const body = b.subarray(2);
    const swapped = Buffer.alloc(body.length - (body.length % 2));
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1] ?? 0;
      swapped[i + 1] = body[i] ?? 0;
    }
    return swapped.toString('utf16le');
  }
  return b.toString('latin1');
}

/** Bytes de um fluxo, descomprimidos (só FlateDecode, com limite de tamanho). */
export function streamBytes(structure: PdfStructure, object: PdfObject): Buffer {
  if (object.stream === undefined)
    throw new PdfStructureError('MALFORMED', `objeto ${object.num} não é um fluxo`);
  const dict = isDict(object.value) ? object.value : undefined;
  const filter = dict?.map.get('Filter');
  const filters = (Array.isArray(filter) ? filter : filter === undefined ? [] : [filter]).map((f) =>
    nameOf(deref(structure, f)),
  );
  if (dict?.map.has('DecodeParms') || dict?.map.has('DP'))
    throw new PdfStructureError('UNSUPPORTED', `fluxo ${object.num} com DecodeParms`);
  if (filters.length === 0) return object.stream;
  if (filters.length === 1 && filters[0] === 'FlateDecode') {
    try {
      return inflateSync(object.stream, {
        maxOutputLength: structure.limits.maxDecodedStreamBytes,
      });
    } catch (error) {
      throw new PdfStructureError(
        'MALFORMED',
        `fluxo ${object.num} não descomprime: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new PdfStructureError(
    'UNSUPPORTED',
    `fluxo ${object.num} com filtro não suportado: ${filters.map(String).join(', ')}`,
  );
}

export interface PageInfo {
  num: number;
  mediaBox?: number[];
  cropBox?: number[];
  rotate: number;
  userUnit: number;
  /** Chaves de caixa extras presentes (TrimBox, BleedBox, ArtBox). */
  extraBoxes: string[];
}

/** Página com o dicionário e os recursos (herdados da árvore de páginas, se for o caso). */
export interface PageNode extends PageInfo {
  dict: PdfDict;
  resources?: PdfDict;
}

const numbers = (structure: PdfStructure, value: PdfValue | undefined): number[] | undefined => {
  const resolved = deref(structure, value);
  if (!Array.isArray(resolved)) return undefined;
  const out = resolved.map((v) => deref(structure, v));
  return out.every((v): v is number => typeof v === 'number') ? out : undefined;
};

/** Páginas na ordem do documento, com MediaBox/CropBox/Rotate/Resources herdados da árvore de páginas. */
export function readPageNodes(structure: PdfStructure): PageNode[] {
  const root = dictOf(
    structure,
    dictOf(structure, structure.trailer.map.get('Root'))?.map.get('Pages'),
  );
  if (root === undefined) throw new PdfStructureError('MALFORMED', 'sem árvore de páginas');
  const pages: PageNode[] = [];
  let visited = 0;
  interface Inherited {
    mediaBox?: number[];
    cropBox?: number[];
    rotate?: number;
    resources?: PdfDict;
  }
  const walk = (node: PdfDict, num: number, inherited: Inherited, depth: number): void => {
    if (depth > structure.limits.maxDepth)
      throw new PdfStructureError('TOO_DEEP', 'árvore de páginas funda demais');
    visited += 1;
    if (visited > structure.limits.maxObjects)
      throw new PdfStructureError('TOO_MANY_OBJECTS', 'árvore de páginas grande demais');
    const mediaBox = numbers(structure, node.map.get('MediaBox')) ?? inherited.mediaBox;
    const cropBox = numbers(structure, node.map.get('CropBox')) ?? inherited.cropBox;
    const rotateRaw = deref(structure, node.map.get('Rotate'));
    const rotate = typeof rotateRaw === 'number' ? rotateRaw : inherited.rotate;
    const resources = dictOf(structure, node.map.get('Resources')) ?? inherited.resources;
    const kids = deref(structure, node.map.get('Kids'));
    if (nameOf(node.map.get('Type')) === 'Pages' || Array.isArray(kids)) {
      if (!Array.isArray(kids)) throw new PdfStructureError('MALFORMED', 'nó de páginas sem /Kids');
      for (const kid of kids) {
        const child = dictOf(structure, kid);
        if (child === undefined) throw new PdfStructureError('MALFORMED', 'página filha inválida');
        walk(
          child,
          isRef(kid) ? kid.num : -1,
          {
            ...(mediaBox ? { mediaBox } : {}),
            ...(cropBox ? { cropBox } : {}),
            ...(rotate === undefined ? {} : { rotate }),
            ...(resources === undefined ? {} : { resources }),
          },
          depth + 1,
        );
      }
      return;
    }
    const unit = deref(structure, node.map.get('UserUnit'));
    pages.push({
      num,
      ...(mediaBox ? { mediaBox } : {}),
      ...(cropBox ? { cropBox } : {}),
      rotate: rotate ?? 0,
      userUnit: typeof unit === 'number' ? unit : 1,
      extraBoxes: ['TrimBox', 'BleedBox', 'ArtBox'].filter((k) => node.map.has(k)),
      dict: node,
      ...(resources === undefined ? {} : { resources }),
    });
  };
  walk(root, -1, {}, 0);
  return pages;
}

/** Páginas (sem os dicionários), como antes. */
export function readPages(structure: PdfStructure): PageInfo[] {
  return readPageNodes(structure).map((node) => ({
    num: node.num,
    ...(node.mediaBox ? { mediaBox: node.mediaBox } : {}),
    ...(node.cropBox ? { cropBox: node.cropBox } : {}),
    rotate: node.rotate,
    userUnit: node.userUnit,
    extraBoxes: node.extraBoxes,
  }));
}

export interface Surface {
  /** De onde veio (para a mensagem). */
  where: string;
  text: string;
}

/**
 * Textos de METADADOS e estrutura (strings e nomes dos dicionários, fora dos fluxos de conteúdo e fora dos
 * endereços `/URI`, que são conteúdo legítimo do currículo). Usado para procurar caminhos locais.
 */
export function metadataSurfaces(structure: PdfStructure): Surface[] {
  const out: Surface[] = [];
  const visit = (value: PdfValue, where: string, depth: number): void => {
    if (depth > structure.limits.maxDepth) return;
    if (isPdfString(value)) out.push({ where, text: decodeText(value) });
    else if (Array.isArray(value))
      value.forEach((v) => {
        visit(v, where, depth + 1);
      });
    else if (isDict(value)) {
      for (const [key, v] of value.map) {
        if (key === 'URI') continue;
        out.push({ where: `${where}/${key}`, text: key });
        const name = nameOf(v);
        if (name !== undefined) out.push({ where: `${where}/${key}`, text: name });
        visit(v, `${where}/${key}`, depth + 1);
      }
    }
  };
  for (const object of structure.objects.values()) visit(object.value, `obj ${object.num}`, 0);
  return out;
}
