import { clip, result, type CheckResult } from './checks.js';
import { analyzePages } from './content-stream.js';
import type { ExtractedPdf } from './extract.js';
import { firstDifference } from './normalize.js';
import {
  decodeText,
  deref,
  isDict,
  isPdfString,
  isRef,
  nameOf,
  type PdfDict,
  type PdfObject,
  type PdfStructure,
  type PdfValue,
} from './pdf-objects.js';
import { MIN_BODY_PT } from '../render/layout.js';

/**
 * H10 — elementos e ações perigosos, estruturas não permitidas e conteúdo escondido.
 *
 * Três camadas, todas por LISTA DE PERMISSÃO (o que não está listado reprova):
 *  1. o pdfjs como segunda opinião (JavaScript, anexos, formulários, XFA, anotações com ação);
 *  2. a estrutura do arquivo, percorrida por PAPEL (catálogo, páginas, recursos, fontes, anotações, árvore de
 *     estrutura, fluxos): cada dicionário só pode ter as chaves previstas e todo objeto precisa ser alcançado por
 *     um caminho permitido, senão é objeto órfão ou fluxo não autorizado;
 *  3. o fluxo de conteúdo de cada página, interpretado operador a operador (`content-stream.ts`): operadores
 *     fora da lista, texto invisível, quase branco, de tamanho indevido ou totalmente fora da página, e o texto
 *     decodificado dos operadores comparado, SEM normalização, com o que o pdfjs extraiu.
 *
 * Exceções existentes (todas específicas, justificadas e cobertas por teste):
 *  - objeto órfão: só um DICIONÁRIO VAZIO sem fluxo (o PDFKit grava um, sem referência);
 *  - chave `/length` (minúscula) no fluxo XMP (o PDFKit a grava junto com `/Length`);
 *  - `/Names` do catálogo: só a árvore `/Dests` vazia que o PDFKit sempre escreve.
 */
export const DANGEROUS_KEYS = new Set([
  'JavaScript',
  'JS',
  'Launch',
  'OpenAction',
  'AA',
  'AcroForm',
  'EmbeddedFiles',
  'EmbeddedFile',
  'EF',
  'Filespec',
  'XFA',
  'RichMedia',
  'Movie',
  'Sound',
  '3D',
  'SubmitForm',
  'ImportData',
  'GoToR',
  'GoToE',
  'Rendition',
  'Thread',
  'Encrypt',
]);

/** Tamanho efetivo do texto: abaixo do mínimo do layout é ilegível; acima disto, absurdo para um currículo. */
export const MAX_TEXT_PT = 48;
const FONT_TOLERANCE_PT = 0.1;

const CATALOG_KEYS = [
  'Type',
  'Pages',
  'Names',
  'Lang',
  'MarkInfo',
  'StructTreeRoot',
  'ViewerPreferences',
  'Metadata',
];
const PAGES_KEYS = ['Type', 'Count', 'Kids', 'Parent'];
const PAGE_KEYS = [
  'Type',
  'Parent',
  'MediaBox',
  'Contents',
  'Resources',
  'UserUnit',
  'StructParents',
  'Annots',
  'Tabs',
];
const RESOURCE_KEYS = ['ProcSet', 'Font', 'ColorSpace'];
const PROC_SETS = new Set(['PDF', 'Text', 'ImageB', 'ImageC', 'ImageI']);
const TYPE0_KEYS = ['Type', 'Subtype', 'BaseFont', 'Encoding', 'DescendantFonts', 'ToUnicode'];
const CIDFONT_KEYS = [
  'Type',
  'Subtype',
  'BaseFont',
  'CIDSystemInfo',
  'FontDescriptor',
  'W',
  'DW',
  'CIDToGIDMap',
];
const DESCRIPTOR_KEYS = [
  'Type',
  'FontName',
  'Flags',
  'FontBBox',
  'ItalicAngle',
  'Ascent',
  'Descent',
  'CapHeight',
  'XHeight',
  'StemV',
  'FontFile2',
];
const ANNOT_KEYS = ['Type', 'Subtype', 'Rect', 'Border', 'F', 'A'];
const ACTION_KEYS = ['Type', 'S', 'URI'];
const STRUCT_ROOT_KEYS = ['Type', 'K', 'ParentTree', 'ParentTreeNextKey'];
const STRUCT_ELEMENT_KEYS = ['K', 'P', 'Pg', 'S', 'Type'];
const STRUCT_TYPES = new Set([
  'Document',
  'H1',
  'H2',
  'H3',
  'P',
  'L',
  'LI',
  'Lbl',
  'LBody',
  'Link',
  'Span',
]);
const NUMBER_TREE_KEYS = ['Nums', 'Limits', 'Kids'];
const INFO_KEYS = ['Title', 'Author', 'Subject', 'Producer', 'Creator', 'CreationDate', 'ModDate'];
const STREAM_KEYS: Record<string, string[]> = {
  conteúdo: ['Filter', 'Length'],
  'programa da fonte': ['Filter', 'Length'],
  ToUnicode: ['Filter', 'Length'],
  XMP: ['Type', 'Subtype', 'Length', 'length'],
};
const MAX_LISTED = 8;

/** Remove só o espaço comum (U+0020); nada mais é normalizado na comparação com o pdfjs. */
export const withoutSpaces = (text: string): string => text.split(' ').join('');

export interface DangerousInput {
  structure: PdfStructure | undefined;
  structureError: string | undefined;
  extracted: ExtractedPdf;
  /** Análise das páginas já feita (evita ler o conteúdo duas vezes). */
  analyzed?: ReturnType<typeof analyzePages>;
}

export function checkDangerous(input: DangerousInput): CheckResult {
  const { structure, structureError, extracted } = input;
  const name = 'elementos e ações perigosos';
  const problems: string[] = [];
  const add = (list: string[], label: string): void => {
    if (list.length === 0) return;
    problems.push(...list.slice(0, MAX_LISTED));
    if (list.length > MAX_LISTED)
      problems.push(`${label}: mais ${list.length - MAX_LISTED} ocorrência(s) omitida(s)`);
  };

  // --- 1. pdfjs como segunda opinião
  const sec = extracted.security;
  if (sec.jsActions) problems.push('o pdfjs encontrou ações JavaScript');
  if (sec.attachments) problems.push('o pdfjs encontrou arquivos anexados');
  if (sec.formFields) problems.push('o pdfjs encontrou campos de formulário');
  if (sec.xfa) problems.push('o pdfjs encontrou um formulário XFA');
  if (sec.nonLinkAnnotations.length > 0)
    problems.push(
      `anotações que não são links: ${[...new Set(sec.nonLinkAnnotations)].join(', ')}`,
    );
  if (sec.annotationsWithActions > 0)
    problems.push(`${sec.annotationsWithActions} anotação(ões) com ação ou destino interno`);

  if (structure === undefined)
    return {
      ...result(
        'H10',
        name,
        [
          ...problems,
          `não foi possível ler a estrutura do PDF: ${structureError ?? 'motivo desconhecido'}`,
        ],
        '',
      ),
    };

  // --- 2. estrutura por papel
  add(scanDangerous(structure), 'elementos perigosos');
  add(walkStructure(structure), 'estrutura');

  // --- 3. fluxo de conteúdo de cada página
  add(inspectContent(structure, extracted, input.analyzed), 'conteúdo');

  return result(
    'H10',
    name,
    problems,
    `${structure.objects.size} objetos, todos em caminhos permitidos; nenhuma ação, anexo, formulário ou imagem; conteúdo das páginas só com operadores permitidos, sem texto escondido e igual ao extraído`,
  );
}

// ------------------------------------------------------------------ camada 2a: chaves perigosas em qualquer objeto

function scanDangerous(structure: PdfStructure): string[] {
  const out: string[] = [];
  const visit = (value: PdfValue | undefined, num: number, depth: number): void => {
    if (depth > structure.limits.maxDepth) return;
    if (Array.isArray(value))
      value.forEach((v) => {
        visit(v, num, depth + 1);
      });
    else if (isDict(value)) {
      for (const [key, v] of value.map) {
        if (DANGEROUS_KEYS.has(key)) out.push(`elemento perigoso /${key} no objeto ${num}`);
        if (key === 'Subtype' && ['Image', 'Form', 'PS'].includes(nameOf(v) ?? ''))
          out.push(
            `objeto ${num} do tipo /${nameOf(v) ?? ''} (imagem ou formulário não são permitidos)`,
          );
        if (key === 'Type' && nameOf(v) === 'XObject') out.push(`XObject no objeto ${num}`);
        if (
          key === 'S' &&
          [
            'JavaScript',
            'Launch',
            'GoToR',
            'GoToE',
            'SubmitForm',
            'ImportData',
            'Rendition',
          ].includes(nameOf(v) ?? '')
        )
          out.push(`ação /${nameOf(v) ?? ''} no objeto ${num}`);
        visit(v, num, depth + 1);
      }
    }
  };
  for (const object of structure.objects.values()) visit(object.value, object.num, 0);
  return out;
}

// ------------------------------------------------------------------ camada 2b: caminhada por papel

function walkStructure(structure: PdfStructure): string[] {
  const problems: string[] = [];
  const visited = new Set<number>();
  const where = (role: string, num: number | undefined): string =>
    num === undefined ? role : `${role} (objeto ${num})`;

  /** Segue uma referência (marcando o objeto como alcançado por um caminho permitido). */
  const follow = (
    value: PdfValue | undefined,
    role: string,
  ): { value: PdfValue | undefined; num?: number; object?: PdfObject } => {
    if (!isRef(value)) return { value };
    visited.add(value.num);
    const object = structure.objects.get(value.num);
    if (object === undefined) {
      problems.push(`${role}: referência para o objeto inexistente ${value.num}`);
      return { value: undefined, num: value.num };
    }
    return { value: object.value, num: value.num, object };
  };
  const dictOfRole = (
    value: PdfValue | undefined,
    role: string,
  ): { dict: PdfDict; num?: number } | undefined => {
    const target = follow(value, role);
    if (!isDict(target.value)) {
      problems.push(`${where(role, target.num)} não é um dicionário`);
      return undefined;
    }
    return { dict: target.value, ...(target.num === undefined ? {} : { num: target.num }) };
  };
  const only = (
    dict: PdfDict,
    allowed: readonly string[],
    role: string,
    num: number | undefined,
  ): void => {
    for (const key of dict.map.keys())
      if (!allowed.includes(key))
        problems.push(`chave não permitida em ${where(role, num)}: /${key}`);
  };
  const expectName = (
    dict: PdfDict,
    key: string,
    want: string,
    role: string,
    num: number | undefined,
  ): void => {
    const got = nameOf(deref(structure, dict.map.get(key)));
    if (got !== want)
      problems.push(
        `${where(role, num)}: /${key} deveria ser /${want} (é ${got === undefined ? 'ausente' : `/${got}`})`,
      );
  };
  const stream = (value: PdfValue | undefined, role: string): void => {
    const target = follow(value, role);
    const object = target.object;
    if (object === undefined || object.stream === undefined) {
      problems.push(`${where(role, target.num)} não é um fluxo`);
      return;
    }
    if (isDict(object.value)) {
      only(object.value, STREAM_KEYS[role] ?? [], `fluxo de ${role}`, object.num);
      const filter = nameOf(object.value.map.get('Filter'));
      if (object.value.map.has('Filter') && filter !== 'FlateDecode')
        problems.push(
          `fluxo de ${role} (objeto ${object.num}) com filtro não permitido: ${filter === undefined ? 'inválido' : `/${filter}`}`,
        );
    }
  };
  const array = (value: PdfValue | undefined): PdfValue[] => {
    const resolved = deref(structure, value);
    return Array.isArray(resolved) ? resolved : [];
  };

  // Catálogo
  const rootRef = structure.trailer.map.get('Root');
  const root = dictOfRole(rootRef, 'catálogo');
  if (root !== undefined) {
    only(root.dict, CATALOG_KEYS, 'catálogo', root.num);
    expectName(root.dict, 'Type', 'Catalog', 'catálogo', root.num);
    walkPagesNode(root.dict.map.get('Pages'), 0);

    const names = root.dict.map.get('Names');
    if (names !== undefined) {
      const n = dictOfRole(names, '/Names');
      if (n !== undefined) {
        only(n.dict, ['Dests'], '/Names', n.num);
        const dests = n.dict.map.get('Dests');
        const d = isDict(dests) ? dests : undefined;
        const empty =
          d !== undefined &&
          [...d.map.keys()].join() === 'Names' &&
          Array.isArray(d.map.get('Names')) &&
          (d.map.get('Names') as PdfValue[]).length === 0;
        if (!empty) problems.push('/Names do catálogo não é a árvore /Dests vazia esperada');
      }
    }
    const mark = root.dict.map.get('MarkInfo');
    if (mark !== undefined) {
      const m = dictOfRole(mark, '/MarkInfo');
      if (m !== undefined) only(m.dict, ['Marked'], '/MarkInfo', m.num);
    }
    const viewer = root.dict.map.get('ViewerPreferences');
    if (viewer !== undefined) {
      const v = dictOfRole(viewer, '/ViewerPreferences');
      if (v !== undefined) only(v.dict, ['DisplayDocTitle'], '/ViewerPreferences', v.num);
    }
    const meta = root.dict.map.get('Metadata');
    if (meta !== undefined) stream(meta, 'XMP');
    const tree = root.dict.map.get('StructTreeRoot');
    if (tree !== undefined) walkStructRoot(tree);
  }

  // Info
  const infoValue = structure.trailer.map.get('Info');
  if (infoValue !== undefined) {
    const info = dictOfRole(infoValue, 'Info');
    if (info !== undefined) {
      only(info.dict, INFO_KEYS, 'Info', info.num);
      for (const v of info.dict.map.values()) {
        const target = follow(v, 'valor do Info');
        if (!isPdfString(target.value))
          problems.push(`valor do Info (objeto ${target.num ?? '?'}) não é texto`);
      }
    }
  }

  function walkPagesNode(value: PdfValue | undefined, depth: number): void {
    if (depth > structure.limits.maxDepth) {
      problems.push('árvore de páginas funda demais');
      return;
    }
    const node = dictOfRole(value, 'árvore de páginas');
    if (node === undefined) return;
    const type = nameOf(node.dict.map.get('Type'));
    if (type === 'Pages') {
      only(node.dict, PAGES_KEYS, 'nó de páginas', node.num);
      for (const kid of array(node.dict.map.get('Kids'))) walkPagesNode(kid, depth + 1);
    } else if (type === 'Page') walkPage(node.dict, node.num);
    else problems.push(`${where('nó da árvore de páginas', node.num)} com /Type inesperado`);
  }

  function walkPage(page: PdfDict, num: number | undefined): void {
    only(page, PAGE_KEYS, 'página', num);
    const contents = page.map.get('Contents');
    if (Array.isArray(deref(structure, contents)) && !isRef(contents))
      for (const c of array(contents)) stream(c, 'conteúdo');
    else stream(contents, 'conteúdo');
    const resourcesValue = page.map.get('Resources');
    if (resourcesValue !== undefined) {
      const resources = dictOfRole(resourcesValue, 'recursos da página');
      if (resources !== undefined) {
        only(resources.dict, RESOURCE_KEYS, 'recursos da página', resources.num);
        for (const p of array(resources.dict.map.get('ProcSet')))
          if (!PROC_SETS.has(nameOf(p) ?? ''))
            problems.push(`ProcSet inesperado: ${nameOf(p) ?? '?'}`);
        const colorSpace = deref(structure, resources.dict.map.get('ColorSpace'));
        if (colorSpace !== undefined && !(isDict(colorSpace) && colorSpace.map.size === 0))
          problems.push(
            '/ColorSpace dos recursos não está vazio (espaços de cor nomeados não são permitidos)',
          );
        const fonts = deref(structure, resources.dict.map.get('Font'));
        if (isDict(fonts)) for (const font of fonts.map.values()) walkFont(font);
      }
    }
    for (const annot of array(page.map.get('Annots'))) walkAnnotation(annot);
  }

  function walkFont(value: PdfValue | undefined): void {
    const font = dictOfRole(value, 'fonte');
    if (font === undefined) return;
    only(font.dict, TYPE0_KEYS, 'fonte', font.num);
    expectName(font.dict, 'Subtype', 'Type0', 'fonte', font.num);
    expectName(font.dict, 'Encoding', 'Identity-H', 'fonte', font.num);
    stream(font.dict.map.get('ToUnicode'), 'ToUnicode');
    const descendants = array(font.dict.map.get('DescendantFonts'));
    if (descendants.length !== 1)
      problems.push(`${where('fonte', font.num)} sem exatamente uma fonte descendente`);
    for (const d of descendants) {
      const cid = dictOfRole(d, 'fonte descendente');
      if (cid === undefined) continue;
      only(cid.dict, CIDFONT_KEYS, 'fonte descendente', cid.num);
      expectName(cid.dict, 'Subtype', 'CIDFontType2', 'fonte descendente', cid.num);
      const widths = cid.dict.map.get('W');
      if (isRef(widths)) follow(widths, 'larguras /W');
      const toGid = cid.dict.map.get('CIDToGIDMap');
      if (toGid !== undefined && nameOf(toGid) !== 'Identity')
        problems.push(
          `${where('fonte descendente', cid.num)}: /CIDToGIDMap diferente de /Identity`,
        );
      const info = cid.dict.map.get('CIDSystemInfo');
      if (isRef(info)) {
        const i = dictOfRole(info, 'CIDSystemInfo');
        if (i !== undefined)
          only(i.dict, ['Registry', 'Ordering', 'Supplement'], 'CIDSystemInfo', i.num);
      }
      const descriptor = cid.dict.map.get('FontDescriptor');
      if (descriptor !== undefined) {
        const dd = dictOfRole(descriptor, 'descritor de fonte');
        if (dd !== undefined) {
          only(dd.dict, DESCRIPTOR_KEYS, 'descritor de fonte', dd.num);
          const program = dd.dict.map.get('FontFile2');
          if (program !== undefined) stream(program, 'programa da fonte');
        }
      }
    }
  }

  function walkAnnotation(value: PdfValue | undefined): void {
    const annot = dictOfRole(value, 'anotação');
    if (annot === undefined) return;
    only(annot.dict, ANNOT_KEYS, 'anotação', annot.num);
    expectName(annot.dict, 'Subtype', 'Link', 'anotação', annot.num);
    const action = annot.dict.map.get('A');
    if (action === undefined) {
      problems.push(`${where('anotação', annot.num)} sem ação`);
      return;
    }
    const a = dictOfRole(action, 'ação');
    if (a === undefined) return;
    only(a.dict, ACTION_KEYS, 'ação', a.num);
    expectName(a.dict, 'S', 'URI', 'ação', a.num);
    if (!isPdfString(deref(structure, a.dict.map.get('URI'))))
      problems.push(`${where('ação', a.num)} sem /URI de texto`);
  }

  function walkStructRoot(value: PdfValue | undefined): void {
    const tree = dictOfRole(value, 'árvore de estrutura');
    if (tree === undefined) return;
    only(tree.dict, STRUCT_ROOT_KEYS, 'árvore de estrutura', tree.num);
    expectName(tree.dict, 'Type', 'StructTreeRoot', 'árvore de estrutura', tree.num);
    walkStructKids(tree.dict.map.get('K'), 0);
    const parent = tree.dict.map.get('ParentTree');
    if (parent !== undefined) walkNumberTree(parent, 0);
  }

  function walkStructKids(value: PdfValue | undefined, depth: number): void {
    if (depth > structure.limits.maxDepth) {
      problems.push('árvore de estrutura funda demais');
      return;
    }
    if (typeof value === 'number' || value === undefined) return; // MCID
    if (Array.isArray(value)) {
      for (const v of value) walkStructKids(v, depth + 1);
      return;
    }
    if (isRef(value)) {
      if (visited.has(value.num)) return;
      const target = follow(value, 'elemento de estrutura');
      if (Array.isArray(target.value)) {
        for (const v of target.value) walkStructKids(v, depth + 1);
        return;
      }
      if (!isDict(target.value)) {
        problems.push(`${where('elemento de estrutura', target.num)} não é um dicionário`);
        return;
      }
      walkStructElement(target.value, target.num, depth);
      return;
    }
    if (isDict(value)) walkStructElement(value, undefined, depth);
    else problems.push('filho inesperado na árvore de estrutura');
  }

  function walkStructElement(element: PdfDict, num: number | undefined, depth: number): void {
    only(element, STRUCT_ELEMENT_KEYS, 'elemento de estrutura', num);
    const type = nameOf(element.map.get('S'));
    if (type === undefined || !STRUCT_TYPES.has(type))
      problems.push(
        `${where('elemento de estrutura', num)} com tipo /${type ?? '?'} não permitido`,
      );
    const page = element.map.get('Pg');
    if (isRef(page) && !visited.has(page.num))
      problems.push(`${where('elemento de estrutura', num)} aponta para uma página fora da árvore`);
    walkStructKids(element.map.get('K'), depth + 1);
  }

  function walkNumberTree(value: PdfValue | undefined, depth: number): void {
    if (depth > structure.limits.maxDepth) return;
    const node = dictOfRole(value, 'árvore de números');
    if (node === undefined) return;
    only(node.dict, NUMBER_TREE_KEYS, 'árvore de números', node.num);
    const nums = array(node.dict.map.get('Nums'));
    for (const entry of nums) {
      if (typeof entry === 'number') continue;
      const target = follow(entry, 'entrada da árvore de números');
      const list = Array.isArray(target.value) ? target.value : [];
      if (!Array.isArray(target.value))
        problems.push(`${where('entrada da árvore de números', target.num)} não é uma lista`);
      for (const item of list) {
        if (isRef(item)) follow(item, 'elemento da árvore de números');
      }
    }
    for (const kid of array(node.dict.map.get('Kids'))) walkNumberTree(kid, depth + 1);
  }

  // Objetos que nenhum caminho permitido alcançou: órfãos ou fluxos não autorizados.
  const unreached = [...structure.objects.values()].filter((o) => !visited.has(o.num));
  for (const object of unreached) {
    // Exceção ESPECÍFICA: dicionário vazio e sem fluxo (o PDFKit grava um sem referência). Nada mais.
    if (isDict(object.value) && object.value.map.size === 0 && object.stream === undefined)
      continue;
    const kind =
      object.stream !== undefined
        ? 'fluxo'
        : isDict(object.value)
          ? `dicionário {${[...object.value.map.keys()].join(', ')}}`
          : isPdfString(object.value)
            ? `texto "${clip(decodeText(object.value), 20)}"`
            : Array.isArray(object.value)
              ? 'lista'
              : 'valor';
    problems.push(
      `objeto ${object.num} fora de qualquer caminho permitido (órfão ou não autorizado): ${kind}`,
    );
  }
  return problems;
}

// ------------------------------------------------------------------ camada 3: conteúdo das páginas

function inspectContent(
  structure: PdfStructure,
  extracted: ExtractedPdf,
  analyzed?: ReturnType<typeof analyzePages>,
): string[] {
  const problems: string[] = [];
  const { pages, problems: pageProblems } = analyzed ?? analyzePages(structure);
  if (pageProblems.length > 0) return pageProblems;
  if (pages.length !== extracted.pages)
    problems.push(`a estrutura tem ${pages.length} página(s) e o pdfjs ${extracted.pages}`);

  for (const entry of pages) {
    const page = entry.number;
    const label = `página ${page}`;
    problems.push(...entry.contentProblems.map((p) => `${label}: ${p}`));
    const analysis = entry.analysis;
    if (analysis === undefined) continue;
    problems.push(...entry.fontProblems.map((p) => `${label}: ${p}`));
    problems.push(...analysis.problems.map((p) => `${label}: ${p}`));

    const outside: string[] = [];
    const hidden: string[] = [];
    const sizes: string[] = [];
    const unmapped: string[] = [];
    for (const show of analysis.shows) {
      const sample = `"${clip(show.text, 28)}"`;
      if (show.outside)
        outside.push(`${sample} em (${show.origin[0].toFixed(0)}, ${show.origin[1].toFixed(0)})`);
      if (show.nearWhite)
        hidden.push(
          `${sample} com cor ${show.fill.space} ${show.fill.components.map((c) => c.toFixed(2)).join(' ')}`,
        );
      if (
        show.size < MIN_BODY_PT - FONT_TOLERANCE_PT ||
        show.size > MAX_TEXT_PT ||
        !(show.size > 0)
      )
        sizes.push(
          `${sample} com ${show.size.toFixed(2)} pt (permitido ${MIN_BODY_PT} a ${MAX_TEXT_PT} pt)`,
        );
      if (show.unmapped > 0) unmapped.push(`${sample}: ${show.unmapped} glifo(s)`);
    }
    if (outside.length > 0)
      problems.push(
        `${label}: ${outside.length} trecho(s) de texto totalmente fora da página (invisíveis para quem lê e para os extratores): ${outside.slice(0, 3).join('; ')}`,
      );
    if (hidden.length > 0)
      problems.push(
        `${label}: ${hidden.length} trecho(s) de texto branco ou quase branco: ${hidden.slice(0, 3).join('; ')}`,
      );
    if (sizes.length > 0)
      problems.push(
        `${label}: ${sizes.length} trecho(s) com tamanho de fonte indevido: ${sizes.slice(0, 3).join('; ')}`,
      );
    if (unmapped.length > 0)
      problems.push(
        `${label}: texto com glifos sem mapeamento ToUnicode: ${unmapped.slice(0, 3).join('; ')}`,
      );

    // O texto dos operadores precisa ser IGUAL ao que o pdfjs extraiu da página. A ÚNICA diferença ignorada é o
    // espaço comum (U+0020): o pdfjs perde ou funde espaços entre trechos ("Stack  |  2025" vira "Stack| 2025").
    // Palavras, números, hífens, maiúsculas, pontuação, URLs e qualquer outro caractere continuam exatos.
    const pdfjsText = extracted.runs
      .filter((r) => r.page === page)
      .map((r) => r.text)
      .join('');
    const diff = firstDifference(withoutSpaces(analysis.text), withoutSpaces(pdfjsText));
    if (diff !== undefined)
      problems.push(
        `${label}: o texto dos operadores difere do texto extraído pelo pdfjs a partir do caractere ${diff.at} (ignorando só espaços): operadores "${clip(diff.a)}" × pdfjs "${clip(diff.b)}"`,
      );
  }
  return problems;
}
