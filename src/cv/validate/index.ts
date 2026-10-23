import { createHash } from 'node:crypto';
import { mergeLayout, type LayoutOverrides } from '../render/layout.js';
import type { ResolvedResume } from '../resolve.js';
import {
  checkContent,
  checkIntegrity,
  checkLinks,
  checkReadingOrder,
  skipped,
  type CheckId,
  type CheckResult,
} from './checks.js';
import { expectedContent } from './expected.js';
import { checkDangerous } from './dangerous.js';
import { checkForbiddenContent, type ForbiddenSet } from './forbidden.js';
import { checkGeometry } from './geometry.js';
import { checkMetadata } from './metadata.js';
import {
  PdfStructureError,
  readPages,
  readPdfStructure,
  type PageInfo,
  type PdfStructure,
  type StructureLimits,
} from './pdf-objects.js';
import { PdfReadError, extractForValidation, type ExtractedPdf } from './extract.js';
import {
  defaultRunner,
  runPoppler,
  type PopplerMode,
  type PopplerRunner,
  type PopplerText,
} from './poppler.js';

export { NORMALIZATION_RULES, dropLineEndHyphens, firstDifference, squash } from './normalize.js';
export { expectedContent, type Expected } from './expected.js';
export {
  PdfReadError,
  extractForValidation,
  type ExtractedPdf,
  type LinkAnnotation,
  type TextRun,
} from './extract.js';
export {
  defaultRunner,
  runPoppler,
  type PopplerMode,
  type PopplerRunner,
  type PopplerText,
  type RunResult,
} from './poppler.js';
export { type CheckId, type CheckResult } from './checks.js';
export { NO_FORBIDDEN, type ForbiddenSet, type RetainedItem } from './forbidden.js';
export { GEOMETRY } from './geometry.js';
export { DANGEROUS_KEYS, MAX_TEXT_PT } from './dangerous.js';
export { CMapError, parseToUnicode, type CMap } from './cmap.js';
export {
  ALLOWED_OPERATORS,
  IDENTITY,
  ContentStreamError,
  analyzeContent,
  isNearWhite,
  multiply,
  readFontResources,
  tokenizeContent,
  type ContentAnalysis,
  type ContentOp,
  type FontResource,
  type Matrix,
  type TextShow,
} from './content-stream.js';
export {
  ENVIRONMENT_MARKERS,
  MIN_MARKER_LENGTH,
  pdfDate,
  xmpDate,
  type MetadataExpectation,
} from './metadata.js';
export {
  DEFAULT_LIMITS,
  PdfStructureError,
  readPages,
  readPdfStructure,
  type PdfStructure,
  type StructureLimits,
} from './pdf-objects.js';

/**
 * Validação independente do PDF renderizado (Etapa 4.3, fatia 2, primeira entrega: H1 a H4).
 *
 * Recebe só os bytes e o `ResolvedResume` esperado: relê o PDF com outros extratores e confere o que veio.
 * NÃO é a validação completa: faltam H5 a H10 (frases proibidas, fontes, ligaduras, metadados, geometria,
 * elementos perigosos). Por isso `complete` é sempre `false` aqui e `ok: true` só diz "H1 a H4 passaram".
 */
export interface ValidateOptions {
  layout?: LayoutOverrides;
  /** Número exato de páginas esperado (padrão: qualquer valor entre 1 e o limite do layout). */
  expectedPages?: number;
  /** Poppler como segundo extrator: `auto` (padrão), `require` ou `off`. */
  poppler?: PopplerMode;
  /** Executor do Poppler (para testes). */
  popplerRunner?: PopplerRunner;
  /**
   * Frases rejeitadas, links não confirmados e informações retidas que NÃO podem estar no PDF (H5). Sem isto,
   * o H5 só confere texto inválido (`undefined`, `null`, `NaN`…) e o relatório diz que nada foi informado.
   */
  forbidden?: ForbiddenSet;
  /** Marcadores do ambiente (raiz do projeto, usuário, host…) que não podem aparecer nos metadados (H8). */
  localMarkers?: string[];
  /** Limites do leitor estrutural (padrão defensivo). */
  structureLimits?: Partial<StructureLimits>;
}

export interface ExtractorInfo {
  name: string;
  version?: string;
  status: 'used' | 'skipped' | 'missing' | 'error';
}

export interface ValidationReport {
  /** Todas as verificações IMPLEMENTADAS passaram. */
  ok: boolean;
  /** Sempre `false` nesta entrega: H6 e H7 ainda não existem. */
  complete: false;
  /** Um `ForbiddenSet` foi informado (sem ele, o H5 só confere texto inválido). */
  forbiddenProvided: boolean;
  implemented: CheckId[];
  pending: string[];
  pdfSha256: string;
  pages: number | null;
  extractors: ExtractorInfo[];
  checks: CheckResult[];
}

const IMPLEMENTED: CheckId[] = ['H1', 'H2', 'H3', 'H4', 'H5', 'H8', 'H9', 'H10'];
const PENDING = ['H6', 'H7'];
const NAMES: Record<CheckId, string> = {
  H1: 'integridade básica e quantidade de páginas',
  H2: 'conteúdo esperado × texto extraído (bidirecional)',
  H3: 'ordem de leitura',
  H4: 'URLs visíveis, anotações clicáveis e ausência de links extras',
  H5: 'conteúdo proibido e informações retidas',
  H6: 'fontes embutidas e mapeamento ToUnicode',
  H7: 'ligaduras',
  H8: 'metadados e informação local',
  H9: 'geometria e conteúdo fora das margens',
  H10: 'elementos e ações perigosos',
};

export async function validateRenderedPdf(
  bytes: Buffer,
  resume: ResolvedResume,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const mode = options.poppler ?? 'auto';
  const expected = expectedContent(resume, options.layout);

  let extracted: ExtractedPdf | undefined;
  let readError: string | undefined;
  try {
    extracted = await extractForValidation(bytes);
  } catch (error) {
    readError =
      error instanceof PdfReadError
        ? error.message
        : `Falha inesperada ao ler o PDF: ${String(error)}`;
  }

  let popplerText: PopplerText | undefined;
  if (mode !== 'off' && extracted !== undefined)
    popplerText = runPoppler(bytes, options.popplerRunner ?? defaultRunner);
  const popplerInfo: ExtractorInfo = {
    name: 'poppler (pdftotext)',
    ...(popplerText?.version === undefined ? {} : { version: popplerText.version }),
    status:
      mode === 'off' || popplerText === undefined
        ? 'skipped'
        : !popplerText.available
          ? 'missing'
          : popplerText.error !== undefined
            ? 'error'
            : 'used',
  };

  const integrity = checkIntegrity({
    bytes,
    extracted,
    readError,
    expected,
    expectedPages: options.expectedPages,
  });
  const checks: CheckResult[] = [integrity];
  if (extracted === undefined || (integrity.status === 'fail' && readError !== undefined)) {
    for (const id of ['H2', 'H3', 'H4', 'H5', 'H8', 'H9', 'H10'] as const)
      checks.push(skipped(id, NAMES[id], 'depende de H1 (PDF ilegível)'));
  } else {
    const poppler = { mode, text: popplerText };
    let structure: PdfStructure | undefined;
    let pages: PageInfo[] | undefined;
    let structureError: string | undefined;
    try {
      structure = readPdfStructure(bytes, options.structureLimits);
      pages = readPages(structure);
    } catch (error) {
      structureError =
        error instanceof PdfStructureError
          ? `${error.code}: ${error.message}`
          : `falha inesperada: ${String(error)}`;
      structure = undefined;
      pages = undefined;
    }
    const layout = mergeLayout(options.layout);
    const metadata = checkMetadata({
      structure,
      structureError,
      extracted,
      expectation: {
        title: `${resume.header.name} — ${layout.metadata.subject}`,
        author: resume.header.name,
        subject: layout.metadata.subject,
        producer: layout.metadata.producer,
        creator: layout.metadata.creator,
        date: layout.metadata.date,
        language: resume.language,
      },
      localMarkers: options.localMarkers ?? [],
    });
    checks.push(
      checkContent(extracted, expected, poppler),
      checkReadingOrder(extracted, expected, poppler),
      checkLinks(extracted, expected),
      checkForbiddenContent({
        extracted,
        forbidden: options.forbidden,
        metadataTexts: metadata.texts,
      }),
      metadata.check,
      checkGeometry({ extracted, expected, layout, pages, structureError }),
      checkDangerous({ structure, structureError, extracted }),
    );
  }
  return {
    ok: checks.every((c) => c.status === 'pass'),
    complete: false,
    forbiddenProvided: options.forbidden !== undefined,
    implemented: IMPLEMENTED,
    pending: PENDING,
    pdfSha256: createHash('sha256').update(bytes).digest('hex'),
    pages: extracted?.pages ?? null,
    extractors: [
      {
        name: extracted?.extractor.name ?? 'pdfjs-dist',
        ...(extracted === undefined ? {} : { version: extracted.extractor.version }),
        status: extracted === undefined ? 'error' : 'used',
      },
      popplerInfo,
    ],
    checks,
  };
}
