import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Area } from '../../src/eligibility/areas.js';
import { decisionHash, publicationUnits } from '../../src/cv/decision-context.js';
import type { DecisionManifest } from '../../src/cv/decision-context.js';
import { resolveResume } from '../../src/cv/resolve.js';
import { modelHash, type CvMaster } from '../../src/cv/schema.js';
import type { StrictInputsOptions } from '../../src/cv/strict-inputs.js';
import { approvedModel, reapprove } from './cv-approved.js';
import type { Loaded } from './cv-fixture.js';

export const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export const OK_POPPLER = () => ({ status: 0, stdout: '', stderr: '' });

export interface Project {
  root: string;
  options: StrictInputsOptions;
  anchorSha256: string;
  model: CvMaster;
  paths: Record<'model' | 'declarations' | 'anchor' | 'approval' | 'bundle' | 'master', string>;
}

export function writePrivate(path: string, content: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Projeto sintético completo (modelo, aprovação, âncora, decisões, PDF mestre) em diretório temporário. */
export function makeProject(
  L: Loaded,
  prepare: (model: CvMaster) => void = () => undefined,
  areas: readonly (Area | null)[] = [null, 'desenvolvimento'],
): Project {
  const root = mkdtempSync(join(tmpdir(), 'cvinputs-'));
  const base = approvedModel(L);
  prepare(base);
  const model = reapprove(base);
  const declarations = { schemaVersion: 1, declaracoes: [] as unknown[] };
  const resumes = areas.map((area) =>
    resolveResume(model, { extraction: L.extraction, ...(area === null ? {} : { area }) }),
  );
  const manifest: DecisionManifest = {
    schemaVersion: 1,
    modelHash: modelHash(model),
    modelSnapshotSha256: decisionHash(model),
    declarationsSha256: decisionHash(declarations),
    decisions: [],
    variants: resumes.map((r) => ({
      area: r.area,
      contentSha256: r.manifest.contentSha256,
      units: publicationUnits(model, r).map((u) => ({
        id: u.id,
        textSha256: decisionHash(u.text),
        inherits: u.inherits,
        decisions: [],
      })),
    })),
  };
  const bundle = { manifest, sources: {} };
  const paths = {
    model: join(root, 'config', 'cv-master.json'),
    declarations: join(root, 'data', 'cv-declarations.json'),
    approval: join(root, 'data', 'cv-approvals', 'global-teste.json'),
    bundle: join(root, 'data', 'cv-decisions', 'reconciliation-teste.json'),
    anchor: join(root, 'data', 'cv-decisions', 'authorization-teste.json'),
    master: join(root, 'mestre.pdf'),
  };
  writePrivate(paths.model, json(model));
  writePrivate(paths.declarations, json(declarations));
  writePrivate(paths.master, L.bytes, 0o644);
  writePrivate(paths.bundle, json(bundle));
  const approval = {
    schemaVersion: 1,
    decision: 'explicit-global-editorial-approval',
    by: 'proprietario',
    scope: {
      kind: 'global-editorial-content',
      modelHash: modelHash(model),
      individualDeclarationsApproved: false,
      draftOrRejectedVariantsReleased: false,
      strictCompletionAuthorized: false,
      validForDifferentModelHash: false,
    },
  };
  writePrivate(paths.approval, json(approval));
  const anchor = {
    recordType: 'authorized-reconciliation-integrity-anchor',
    trusted: {
      manifestSha256: decisionHash(manifest),
      sourcesSha256: decisionHash({}),
      modelHash: modelHash(model),
    },
    bundlePath: 'data/cv-decisions/reconciliation-teste.json',
    globalApproval: {
      path: 'data/cv-approvals/global-teste.json',
      sha256: sha(json(approval)),
      modelHash: modelHash(model),
    },
  };
  writePrivate(paths.anchor, json(anchor));
  const anchorSha256 = sha(json(anchor));
  return {
    root,
    anchorSha256,
    model,
    paths,
    options: {
      root,
      modelPath: paths.model,
      masterPdf: { path: paths.master, sha256: model.master.sha256 },
      anchorSha256,
      anchorFile: 'data/cv-decisions/authorization-teste.json',
      popplerRunner: OK_POPPLER,
    },
  };
}
