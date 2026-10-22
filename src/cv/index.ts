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
