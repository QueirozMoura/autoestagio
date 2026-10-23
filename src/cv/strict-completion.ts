import type { ValidationReport } from './validate/index.js';

const IDS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'] as const;
export type CompletionIssue =
  'CHECKS' | 'EXTRACTORS' | 'FONT_IDENTITY' | 'PENDING' | 'BINDINGS' | 'FORBIDDEN_CONTEXT';

/** Só avalia evidências. Não cria complete=true nem recebe flags de confiança do chamador. */
export function completionIssues(
  report: ValidationReport,
  expected: { pdfSha256: string; pages: number },
): CompletionIssue[] {
  const issues: CompletionIssue[] = [];
  const diagnosticComplete: unknown = (report as { complete: unknown }).complete;
  if (
    !report.ok ||
    diagnosticComplete !== false ||
    report.checks.length !== IDS.length ||
    IDS.some(
      (id) => report.checks.filter((c) => c.id === id && c.status === 'pass').length !== 1,
    ) ||
    report.implemented.length !== IDS.length ||
    IDS.some((id) => !report.implemented.includes(id))
  )
    issues.push('CHECKS');
  if (report.pending.length !== 0) issues.push('PENDING');
  if (!report.forbiddenProvided) issues.push('FORBIDDEN_CONTEXT');
  if (
    report.pdfSha256 !== expected.pdfSha256 ||
    report.pages !== expected.pages ||
    !Number.isInteger(expected.pages) ||
    expected.pages < 1
  )
    issues.push('BINDINGS');
  const names = ['pdfjs-dist', 'poppler (pdftotext)'];
  if (
    report.extractors.length !== names.length ||
    names.some(
      (name) =>
        report.extractors.filter(
          (e) =>
            e.name === name &&
            e.status === 'used' &&
            typeof e.version === 'string' &&
            e.version.length > 0,
        ).length !== 1,
    )
  )
    issues.push('EXTRACTORS');
  const identity = report.fontIdentity;
  if (
    identity.status !== 'verified' ||
    identity.pending.length !== 0 ||
    identity.fonts.length === 0 ||
    identity.fonts.some(
      (f) =>
        !f.verified ||
        !f.tablesIdentical ||
        f.ambiguous !== 0 ||
        f.pending.length !== 0 ||
        (f.variant !== 'Lato-Regular' && f.variant !== 'Lato-Bold') ||
        f.glyphs < 1 ||
        [
          f.glyphs,
          f.simpleMatched,
          f.compositeMatched,
          f.emptyMatched,
          f.composite,
          f.empty,
          f.unicodeMatched,
        ].some((n) => !Number.isInteger(n) || n < 0) ||
        f.unicodeMatched > f.glyphs - 1 ||
        f.simpleMatched + f.compositeMatched + f.emptyMatched !== f.glyphs ||
        f.compositeMatched !== f.composite ||
        f.emptyMatched !== f.empty,
    )
  )
    issues.push('FONT_IDENTITY');
  return issues;
}
