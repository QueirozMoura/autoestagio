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
import { analyzePages } from './content-stream.js';
import { checkDangerous } from './dangerous.js';
import { DEFAULT_ALLOWED_FONTS, checkFonts, checkLigatures } from './fonts.js';
import {
  identityReport,
  prepareReferences,
  type FontIdentityReport,
  type ReferenceFontInput,
} from './font-identity.js';
import type { TrueTypeLimits } from './truetype.js';
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
export {
  DEFAULT_ALLOWED_FONTS,
  STANDARD_14,
  classifyMapping,
  collectFonts,
  parsePdffonts,
  suspiciousInText,
  type FontFacts,
  type PdffontsRow,
} from './fonts.js';
export {
  PENDING_B1,
  PROVEN_B1,
  PROVEN_B2,
  REFERENCE_NAMES,
  checkFontIdentity,
  identityReport,
  prepareReferences,
  type FontIdentityReport,
  type FontIdentityStatus,
  type FontIdentitySummary,
  type PreparedReference,
  type PreparedReferences,
  type ReferenceFontInput,
  type ReferenceName,
} from './font-identity.js';
export {
  ALLOWED_TABLES,
  REFERENCE_TRUETYPE_LIMITS,
  DEFAULT_TRUETYPE_LIMITS,
  REQUIRED_TABLES,
  readTrueType,
  type TrueTypeFont,
  type TrueTypeLimits,
  type TrueTypeReading,
} from './truetype.js';
export { CMapError, parseToUnicode, type CMap } from './cmap.js';
export {
  ALLOWED_OPERATORS,
  IDENTITY,
  ContentStreamError,
  analyzeContent,
  analyzePages,
  isNearWhite,
  multiply,
  readFontResources,
  tokenizeContent,
  type ContentAnalysis,
  type ContentOp,
  type FontResource,
  type PageAnalysis,
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
  /** Padrões aceitos para o nome das fontes embutidas (padrão: subconjuntos da Lato). */
  allowedFonts?: readonly RegExp[];
  /** Limites do leitor TrueType (padrão defensivo). */
  fontLimits?: Partial<TrueTypeLimits>;
  /**
   * Bytes da Lato original (Regular e Bold) para comparar com os subconjuntos embutidos. O validador não abre
   * arquivos: quem chama entrega os bytes. Opcional na 2b-ii-b1; a integração final (2c) vai exigi-los.
   */
  referenceFonts?: readonly ReferenceFontInput[];
  /** Limites para ler as referências (padrão: fonte completa). */
  referenceLimits?: Partial<TrueTypeLimits>;
}

export interface ExtractorInfo {
  name: string;
  version?: string;
  status: 'used' | 'skipped' | 'missing' | 'error';
}

export interface ValidationReport {
  /** Todas as verificações IMPLEMENTADAS passaram. */
  ok: boolean;
  /**
   * Sempre `false` aqui: a integração final (2c) ainda está pendente, mesmo com identidade verificada.
   */
  complete: false;
  /** Um `ForbiddenSet` foi informado (sem ele, o H5 só confere texto inválido). */
  forbiddenProvided: boolean;
  /**
   * Identidade com a referência Lato: `verified` exige compostos, vazios e Unicode comprovados.
   * Ausência de dados ou ambiguidades mantém `partial`. Isto não conclui a integração 2c.
   */
  fontIdentity: FontIdentityReport;
  implemented: CheckId[];
  pending: string[];
  pdfSha256: string;
  pages: number | null;
  extractors: ExtractorInfo[];
  checks: CheckResult[];
}

const IMPLEMENTED: CheckId[] = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'];
const PENDING: string[] = [];
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
  let fontIdentity: FontIdentityReport = identityReport(
    options.referenceFonts === undefined ? 'not-supplied' : 'not-run',
  );
  if (extracted === undefined || (integrity.status === 'fail' && readError !== undefined)) {
    for (const id of ['H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'] as const)
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
    const references = prepareReferences(options.referenceFonts, options.referenceLimits);
    const analyzed = structure === undefined ? undefined : analyzePages(structure);
    const fonts = checkFonts({
      structure,
      structureError,
      pages: analyzed?.pages ?? [],
      poppler,
      allowedFonts: options.allowedFonts ?? DEFAULT_ALLOWED_FONTS,
      ...(references === undefined ? {} : { references }),
      ...(options.fontLimits === undefined ? {} : { limits: options.fontLimits }),
    });
    fontIdentity = fonts.identity;
    const operatorText = (analyzed?.pages ?? []).map((p) => p.analysis?.text ?? '').join('\n');
    checks.push(
      checkContent(extracted, expected, poppler),
      checkReadingOrder(extracted, expected, poppler),
      checkLinks(extracted, expected),
      checkForbiddenContent({
        extracted,
        forbidden: options.forbidden,
        metadataTexts: metadata.texts,
      }),
      fonts.check,
      checkLigatures({
        structure,
        structureError,
        fonts: fonts.fonts,
        texts: [
          { source: 'pdfjs, ordem do fluxo', text: extracted.streamText },
          { source: 'operadores do conteúdo', text: operatorText },
          ...(popplerText?.raw === undefined ? [] : [{ source: 'Poppler', text: popplerText.raw }]),
        ],
      }),
      metadata.check,
      checkGeometry({ extracted, expected, layout, pages, structureError }),
      checkDangerous({
        structure,
        structureError,
        extracted,
        ...(analyzed === undefined ? {} : { analyzed }),
      }),
    );
  }
  return {
    ok: checks.every((c) => c.status === 'pass'),
    complete: false,
    forbiddenProvided: options.forbidden !== undefined,
    fontIdentity,
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
