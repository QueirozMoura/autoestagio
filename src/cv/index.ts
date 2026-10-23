export { detectClaims, type ClaimReport } from './claims.js';
export { fidelityReport, modelTexts, type FidelityReport, type TextUnit } from './fidelity.js';
export { verifyLinks, type LinkCheck, type LinkVerdict } from './links.js';
export {
  CvParseError,
  joinLines,
  normalizeText,
  parseMaster,
  slugify,
  splitList,
  type ParseResult,
} from './parse.js';
export {
  extractPdf,
  extractPdfBytes,
  type PdfExtraction,
  type PdfLine,
  type PdfLink,
} from './pdf.js';
export { buildProposals, verifyProposals, type ProposalSet } from './proposals.js';
export { buildReport, enrichModel, formatReport, type CvReport } from './report.js';
export {
  cvMasterSchema,
  canonicalJson,
  modelHash,
  sha256Text,
  type Claim,
  type CvMaster,
  type Proposal,
} from './schema.js';
export {
  ORIGINAL_SECTION_TITLES,
  ResumeResolutionError,
  bannedPhrases,
  confirmedLinks,
  effectiveCertification,
  effectiveEntryTechnologies,
  effectiveEntryTitle,
  effectiveSectionTitles,
  effectiveSkill,
  isConfirmedLink,
  resolveResume,
  tryResolveResume,
  type Effective,
  type ManifestField,
  type ManifestVariant,
  type ResolveErrorCode,
  type ResolveOptions,
  type ResolvedEntry,
  type ResolvedLink,
  type ResolvedResume,
  type ResolvedSection,
  type ResolvedSkill,
  type ResumeManifest,
  type TryResolveResult,
} from './resolve.js';
export {
  MissingApprovedVariantError,
  approvedVariants,
  isModelFullyApproved,
  isUsableVariant,
  requiredBlocksWithoutApproval,
  selectForResume,
  selectVariant,
  type Variant,
} from './selection.js';
export { ModelExistsError, loadModel, saveModel, saveReport } from './store.js';
export {
  DEFAULT_LAYOUT,
  FONT_DIR,
  FONT_FILES,
  FONT_LICENSE_FILE,
  FontLoadError,
  MIN_BODY_PT,
  RenderError,
  layoutProblems,
  loadFonts,
  mergeLayout,
  renderResume,
  type FitStep,
  type LayoutConfig,
  type LayoutOverrides,
  type RenderErrorCode,
  type RenderOptions,
  type RenderResult,
} from './render/index.js';
export {
  NORMALIZATION_RULES,
  NO_FORBIDDEN,
  expectedContent,
  validateRenderedPdf,
  type CheckId,
  type CheckResult,
  type Expected,
  type ExtractorInfo,
  type ForbiddenSet,
  type PopplerMode,
  type PopplerRunner,
  type RetainedItem,
  type ValidateOptions,
  type ValidationReport,
} from './validate/index.js';
