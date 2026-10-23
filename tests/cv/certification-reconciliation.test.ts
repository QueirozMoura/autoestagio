import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { reconcileCertification } from '../../src/cv/certification-reconciliation.js';
import { cvMasterSchema, modelHash, type CvMaster } from '../../src/cv/schema.js';
import { resolveResume, effectiveCertification } from '../../src/cv/resolve.js';
import { renderAndValidateResume } from '../../src/cv/strict.js';
import { loadFonts } from '../../src/cv/render/fonts.js';
import { loadFictional, type Loaded } from '../helpers/cv-fixture.js';
import { approvedModel, must, reapprove } from '../helpers/cv-approved.js';

let fixture: Loaded;
let original: CvMaster;
beforeAll(async () => {
  fixture = await loadFictional();
  original = approvedModel(fixture);
});
const bytes = Buffer.from('documento fictício revisado visualmente; não é um certificado pessoal');
const digest = createHash('sha256').update(bytes).digest('hex');
const input = () => ({
  model: structuredClone(original),
  certificationId: must(original.certifications[0]).id,
  certificateBytes: Buffer.from(bytes),
  reviewedEvidence: {
    evidenceId: 'evidence-ficticia',
    sha256: digest,
    sizeBytes: bytes.length,
    observed: {
      courseTitle: 'Curso documental corrigido',
      presentedIssuer: 'Instituto Exemplo',
      holderName: 'Pessoa Fictícia',
      documentType: 'Certificate of Completion',
      completionStatement: 'has completed',
      completionDate: null,
    },
    externalAuthenticity: 'not-verified',
  },
  editorialDecision: {
    decisionId: 'decision-ficticia',
    approvedAt: '2026-10-22',
    recordedAt: '2026-10-23T02:00:00Z',
    by: 'proprietario',
    source: 'mensagem explícita fictícia',
    editorialText: 'Curso documental corrigido — Instituto Exemplo',
    scope: 'editorial-documentary-only',
  },
});

describe('reconciliação documental limitada da certificação', () => {
  it('preserva a fonte, claims, aprovação anterior e todos os demais campos', () => {
    const request = input();
    const before = structuredClone(request);
    const result = reconcileCertification(request);
    expect(structuredClone(request)).toEqual(before);
    expect(result.history.previousApproval).toEqual(original.approval);
    expect(result.history.previousCertification).toEqual(original.certifications[0]);
    expect(result.model.approval).toBeUndefined();
    expect(result.decision.globalApproval).toBe('pending');
    expect(result.decision.externalAuthenticity).toBe('not-verified');
    expect(result.decision.evidenceSha256).toBe(digest);
    expect(result.newModelHash).toBe(modelHash(result.model));
    expect(result.newModelHash).not.toBe(original.approval?.modelHash);
    const restored = structuredClone(result.model);
    expect(restored.claims.slice(0, -1)).toEqual(original.claims);
    expect(must(restored.claims.at(-1)).quote).toBe(request.editorialDecision.editorialText);
    restored.claims = structuredClone(original.claims);
    restored.certifications = structuredClone(original.certifications);
    restored.approval = must(original.approval);
    expect(restored).toEqual(original);
  });
  it.each(['hash incorreto', 'documento substituído', 'tamanho incorreto'])(
    'rejeita %s',
    (attack) => {
      const request = input();
      if (attack === 'hash incorreto') request.reviewedEvidence.sha256 = '0'.repeat(64);
      if (attack === 'documento substituído')
        request.certificateBytes[0] = must(request.certificateBytes[0]) ^ 1;
      if (attack === 'tamanho incorreto') request.reviewedEvidence.sizeBytes++;
      expect(() => reconcileCertification(request)).toThrow('CERTIFICATE_INTEGRITY');
    },
  );
  it.each(['título antigo — Instituto Exemplo', 'Curso documental corrigido — Outro emissor'])(
    'rejeita redação não correspondente: %s',
    (text) => {
      const request = input();
      request.editorialDecision.editorialText = text;
      expect(() => reconcileCertification(request)).toThrow('CERTIFICATE_EDITORIAL_MISMATCH');
    },
  );
  it.each(['year', 'description', 'workloadHours', 'professionalLevel', 'competencies'])(
    'rejeita campo documental não conferido: %s',
    (field) => {
      const request = input();
      Object.assign(request.reviewedEvidence.observed, { [field]: 'não autorizado' });
      expect(() => reconcileCertification(request)).toThrow();
    },
  );
  it('não permite promover a autenticidade externa nem acrescentar aprovação global', () => {
    const evidenceAttack = input();
    Object.assign(evidenceAttack.reviewedEvidence, { externalAuthenticity: 'verified' });
    expect(() => reconcileCertification(evidenceAttack)).toThrow();
    const approvalAttack = input();
    Object.assign(approvalAttack.editorialDecision, { globalApproval: true });
    expect(() => reconcileCertification(approvalAttack)).toThrow();
  });
  it('rejeita ausência de decisão, responsável e data inválidos', () => {
    for (const edit of [
      { editorialDecision: undefined },
      { editorialDecision: { ...input().editorialDecision, by: 'codex' } },
      { editorialDecision: { ...input().editorialDecision, approvedAt: '2026-02-30' } },
    ])
      expect(() => reconcileCertification({ ...input(), ...edit })).toThrow();
  });
  it('rejeita alvo inexistente e modelo com aprovação obsoleta na entrada', () => {
    expect(() => reconcileCertification({ ...input(), certificationId: 'inexistente' })).toThrow(
      'CERTIFICATE_NOT_FOUND',
    );
    const request = input();
    must(request.model.certifications[0]).curated = {
      ...must(must(request.model.certifications[0]).curated),
      text: 'alteração posterior à aprovação',
    };
    expect(() => reconcileCertification(request)).toThrow(/obsoleta/u);
  });
  it('não sobrescreve decisão documental anterior nem reconcilia duas vezes', () => {
    const request = input();
    const first = reconcileCertification(request);
    expect(() => reconcileCertification({ ...request, model: first.model })).toThrow(
      'CERTIFICATE_ALREADY_RECONCILED',
    );
  });
  it('a aprovação antiga não serve para o modelo corrigido', () => {
    const { model } = reconcileCertification(input());
    expect(() => resolveResume(model, { extraction: fixture.extraction })).toThrow(/aprovado/u);
    model.approval = must(original.approval);
    expect(cvMasterSchema.safeParse(model).success).toBe(false);
    expect(() => resolveResume(model, { extraction: fixture.extraction })).toThrow(/obsoleta/u);
  });
  it('após aprovação fictícia separada, publica somente o título e emissor corrigidos', () => {
    const { model } = reconcileCertification(input());
    const cert = must(model.certifications[0]);
    expect(cert.curated?.withheld).toEqual(['year', 'description']);
    expect(effectiveCertification(cert)?.value).toBe(input().editorialDecision.editorialText);
    const resolved = resolveResume(reapprove(model), { extraction: fixture.extraction });
    expect(resolved.certifications).toEqual([input().editorialDecision.editorialText]);
    expect(resolved.certifications.join()).not.toContain(String(cert.year));
    expect(resolved.certifications.join()).not.toContain(must(cert.description));
  });
  it('a integração estrita continua bloqueada sem aprovação global e não retorna artefato', async () => {
    const { model } = reconcileCertification(input());
    const fonts = loadFonts();
    const result = await renderAndValidateResume({
      model,
      masterPdf: fixture.bytes,
      declarations: { schemaVersion: 1, declaracoes: [] },
      referenceFonts: [
        { name: 'Lato-Regular', bytes: fonts.regular },
        { name: 'Lato-Bold', bytes: fonts.bold },
      ],
      localContext: {
        projectRoot: '/projeto/ficticio',
        userName: 'ficticio',
        hostName: 'ficticio',
      },
    });
    expect(result.report.ok).toBe(false);
    expect(result.report.complete).toBe(false);
    expect(result.report.issues).toContain('RESOLUTION');
    expect(result.artifact).toBeUndefined();
  });
});
