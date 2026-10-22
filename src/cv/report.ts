import { claimSchema, modelHash, type Claim, type CvMaster } from './schema.js';
import { detectClaims } from './claims.js';
import { fidelityReport, type FidelityReport } from './fidelity.js';
import type { LinkCheck } from './links.js';
import type { PdfExtraction } from './pdf.js';
import { buildProposals, verifyProposals } from './proposals.js';

export interface CvReport {
  generatedAt: string;
  master: { sha256: string; label: string; pages: number; modelHash: string };
  fidelity: FidelityReport;
  claims: Claim[];
  inconsistencies: string[];
  proposals: { count: number; problems: string[] };
  links?: LinkCheck[];
  approval: {
    modelApproved: boolean;
    blocksApproved: number;
    blocksTotal: number;
    linksConfirmed: number;
    linksTotal: number;
  };
}

/** Completa o modelo com as afirmações a confirmar e as propostas (tudo `pendente`/`proposta`). */
export function enrichModel(model: CvMaster): CvMaster {
  const { claims } = detectClaims(model);
  const proposals = buildProposals(model);
  return { ...model, claims: claims.map((c) => claimSchema.parse(c)), proposals };
}

export function buildReport(input: {
  model: CvMaster;
  extraction: PdfExtraction;
  crossCheck?: { extractor: string; text: string };
  links?: LinkCheck[];
  now?: Date;
}): CvReport {
  const { model, extraction } = input;
  const detected = detectClaims(model);
  // O estado das afirmações vem do modelo (o que você já resolveu); a detecção só aponta o que existe.
  const stored = new Map(model.claims.map((c) => [c.id, c]));
  const claims = detected.claims.map((c) => {
    const known = stored.get(c.id);
    return known === undefined
      ? c
      : {
          ...c,
          status: known.status,
          ...(known.resolution ? { resolution: known.resolution } : {}),
        };
  });
  const open = claims.filter((c) => c.kind === 'inconsistencia' && c.status === 'pendente');
  const inconsistencies = detected.inconsistencies.filter((why) =>
    open.some((c) => c.question.startsWith(why)),
  );
  const blocks = [
    model.identity.headline,
    model.summary,
    ...model.experience.flatMap((e) => e.bullets),
    ...model.projects.flatMap((e) => e.bullets),
  ];
  const variants = blocks.flatMap((b) => b.variants);
  const links = [
    ...model.identity.links,
    ...model.experience.flatMap((e) => e.links),
    ...model.projects.flatMap((e) => e.links),
  ];
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    master: {
      sha256: model.master.sha256,
      label: model.master.label,
      pages: model.master.pages,
      modelHash: modelHash(model),
    },
    fidelity: fidelityReport(model, extraction, input.crossCheck),
    claims,
    inconsistencies,
    proposals: {
      count: model.proposals.items.length,
      problems: verifyProposals(model, model.proposals.items),
    },
    ...(input.links === undefined ? {} : { links: input.links }),
    approval: {
      modelApproved: model.approval !== undefined,
      blocksApproved: variants.filter((v) => v.status === 'aprovado').length,
      blocksTotal: variants.length,
      linksConfirmed: links.filter((l) => l.confirmedByUser).length,
      linksTotal: links.length,
    },
  };
}

const pct = (a: number, b: number): string => `${a}/${b}`;

export function formatReport(report: CvReport, model: CvMaster): string {
  const f = report.fidelity;
  const lines: string[] = [
    '══ FIDELIDADE (modelo × PDF mestre) ══',
    `Veredito: ${f.verdict.toUpperCase()} | PDF: ${report.master.label} | SHA-256 ${report.master.sha256.slice(0, 12)}… ${f.masterSha256.matches ? '(confere com o do modelo)' : '(NÃO confere)'}`,
    `Blocos de texto encontrados no PDF: ${pct(f.blocks.found, f.blocks.total)} | na ordem: ${pct(f.order.inOrder, f.order.total)} | campos derivados válidos: ${pct(f.derivedFields.checked - f.derivedFields.invalid.length, f.derivedFields.checked)}`,
    `Por seção: ${f.bySection.map((s) => `${s.section} ${pct(s.found, s.total)}`).join(' · ')}`,
    `Palavras no PDF e ausentes do modelo (omissões): ${f.omittedFromModel.length} | no modelo e ausentes do PDF (invenções): ${f.notInPdf.length}`,
    `Números só no PDF: ${f.numbers.inPdfNotModel.length} | só no modelo: ${f.numbers.inModelNotPdf.length}`,
    `Links: ${pct(f.links.matching, f.links.inModel)} idênticos às anotações do PDF (${f.links.inPdf} no PDF)`,
  ];
  if (f.crossCheck !== undefined) {
    lines.push(
      `Segundo extrator (${f.crossCheck.extractor}): ${pct(f.crossCheck.found, f.crossCheck.total)}${f.crossCheck.explained.length > 0 ? ` — ${f.crossCheck.explained.length} divergência(s) explicada(s) por hífen em quebra de linha` : ''}${f.crossCheck.missing.length > 0 ? `; AUSENTES: ${f.crossCheck.missing.join(', ')}` : ''}`,
    );
  }
  for (const detail of [
    ...f.blocks.missing.map((m) => `bloco ausente do PDF: ${m.id}`),
    ...f.derivedFields.invalid,
    ...f.links.mismatches,
  ])
    lines.push(`  ! ${detail}`);

  const pending = report.claims.filter((c) => c.status === 'pendente');
  const confirmed = report.claims.filter((c) => c.status === 'confirmada').length;
  const rejected = report.claims.filter((c) => c.status === 'rejeitada').length;
  lines.push(
    '',
    `══ AFIRMAÇÕES QUE PRECISAM DA SUA CONFIRMAÇÃO (${pending.length} pendentes de ${report.claims.length}; ${confirmed} confirmadas, ${rejected} rejeitadas) ══`,
  );
  const kinds = [...new Set(pending.map((c) => c.kind))];
  for (const kind of kinds) {
    const group = pending.filter((c) => c.kind === kind);
    lines.push(`── ${kind} (${group.length})`);
    for (const c of group.slice(0, kind === 'link' ? 0 : 20))
      lines.push(`  • [${c.blockId}] "${c.quote.slice(0, 110)}"\n      ? ${c.question}`);
    if (kind === 'link') lines.push('  (os 13 links estão na seção de links abaixo)');
  }
  if (report.inconsistencies.length > 0) {
    lines.push(
      '',
      '══ INCONSISTÊNCIAS ARITMÉTICAS ══',
      ...report.inconsistencies.map((i) => `  ! ${i}`),
    );
  }

  if (report.links !== undefined) {
    lines.push('', '══ LINKS (evidência; nenhum foi aprovado nem corrigido) ══');
    for (const l of report.links) {
      const http =
        l.http === undefined
          ? 'sem resposta'
          : 'error' in l.http
            ? l.http.error
            : `HTTP ${l.http.status}${l.http.title === undefined ? '' : ` — "${l.http.title.slice(0, 50)}"`}`;
      lines.push(
        `  [${l.verdict.toUpperCase()}] ${l.scope === 'cabecalho' ? '' : `${l.scope} · `}${l.label}: ${l.url}`,
        `      ${http}${l.github?.canonicalName === undefined ? '' : ` | GitHub: ${l.github.canonicalName}${l.github.language == null ? '' : ` (${l.github.language})`}`}`,
      );
      for (const note of l.notes) lines.push(`      ⚠ ${note}`);
      for (const c of l.corroboration) lines.push(`      ✓ ${c}`);
      if (l.github?.readme !== undefined) {
        lines.push(
          `      README — termos do currículo encontrados: ${l.github.readme.found.join(', ') || 'nenhum'}${l.github.readme.notFound.length > 0 ? ` | NÃO encontrados: ${l.github.readme.notFound.join(', ')}` : ''}`,
        );
      }
    }
  }

  lines.push('', `══ PROPOSTAS (${report.proposals.count}) — NÃO APROVADAS ══`);
  for (const p of model.proposals.items)
    lines.push(
      `  [${p.id}] (${p.text.length} caracteres)\n    ${p.text}\n    ↳ ${p.flags.join('; ')}`,
    );
  for (const n of model.proposals.notProposed) lines.push(`  (${n.area}) ${n.reason}`);
  if (report.proposals.problems.length > 0)
    lines.push(...report.proposals.problems.map((p) => `  ! ${p}`));

  lines.push(
    '',
    '══ APROVAÇÃO ══',
    `Modelo aprovado: ${report.approval.modelApproved ? 'sim' : 'NÃO'} | blocos aprovados: ${pct(report.approval.blocksApproved, report.approval.blocksTotal)} | links confirmados: ${pct(report.approval.linksConfirmed, report.approval.linksTotal)}`,
    report.approval.blocksApproved === 0 && report.approval.linksConfirmed === 0
      ? 'Nada foi aprovado, corrigido ou enviado. Tudo continua em rascunho até você decidir.'
      : 'Nada foi enviado. Só vale como aprovado o que você confirmou (status "aprovado" com data).',
  );
  return lines.join('\n');
}
