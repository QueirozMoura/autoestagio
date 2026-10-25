import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { Profile } from '../config/index.js';
import { profileHash } from '../eligibility/index.js';
import { usableRecipient } from '../email/recipients.js';
import { candidateEmail } from './email-connector.js';
import type { Policy } from './policy.js';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const https = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
});

/** Evidência externa revista pela pessoa: um formulário público não serve como autorização. */
export const autoApplyManifestSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean().default(false),
  jobs: z
    .array(
      z.strictObject({
        jobId: z.number().int().positive(),
        channel: z.literal('email'),
        jobContentHash: sha,
        profileHash: z.string().regex(/^[a-f0-9]{16}$/),
        cvSha256: sha,
        recipient: z.email(),
        reviewedAt: z.iso.datetime({ offset: true }),
        validUntil: z.iso.datetime({ offset: true }),
        revokedAt: z.iso.datetime({ offset: true }).optional(),
        /** Este conector só suporta CV e mensagem factual; qualquer pergunta/consentimento adicional bloqueia. */
        noAdditionalQuestionsOrConsents: z.boolean(),
        permission: z.strictObject({
          kind: z.enum(['official_documentation', 'written_authorization']),
          sourceUrl: https,
          issuerDomain: z.string().regex(/^[a-z0-9.-]+$/),
          artifactPath: z.string().min(1),
          artifactSha256: sha,
          explicitlyAllowsAutomation: z.literal(true),
          reviewedAt: z.iso.datetime({ offset: true }),
        }),
      }),
    )
    .superRefine((jobs, ctx) => {
      if (new Set(jobs.map((job) => job.jobId)).size !== jobs.length)
        ctx.addIssue({ code: 'custom', message: 'jobId duplicado no manifesto' });
    }),
});

export type AutoApplyManifest = z.infer<typeof autoApplyManifestSchema>;
export interface AutoApplySnapshot {
  manifest: AutoApplyManifest;
  sha256: string;
  directory: string;
}
export type AutoApplyLoader = () => AutoApplySnapshot;

export function loadAutoApplyManifest(path: string): AutoApplySnapshot {
  if (!existsSync(path))
    return {
      manifest: { version: 1, enabled: false, jobs: [] },
      sha256: hash('missing'),
      directory: dirname(path),
    };
  const bytes = readFileSync(path);
  return {
    manifest: autoApplyManifestSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown),
    sha256: hash(bytes),
    directory: dirname(path),
  };
}

export interface AutoApplyCheck {
  ok: boolean;
  reason: string;
  manifestSha256?: string;
  permissionSha256?: string;
}

export function checkAutoApply(options: {
  db: Db;
  profile: Profile;
  policy: Policy;
  jobId: number;
  load: AutoApplyLoader;
  now: Date;
  real: boolean;
}): AutoApplyCheck {
  const deny = (reason: string): AutoApplyCheck => ({ ok: false, reason });
  let snapshot: AutoApplySnapshot;
  try {
    snapshot = options.load();
  } catch {
    return deny('manifesto AUTO_APPLY inválido ou ilegível');
  }
  if (!snapshot.manifest.enabled) return deny('AUTO_APPLY desativado no manifesto');
  if (options.real && options.policy.real.autoApplyManifestSha256 !== snapshot.sha256)
    return deny('manifesto não está vinculado à política/concessão atual (SHA-256)');
  const entry = snapshot.manifest.jobs.find((job) => job.jobId === options.jobId);
  if (!entry) return deny('sem autorização verificável para esta vaga/canal');
  if (entry.revokedAt) return deny('autorização desta vaga revogada');
  if (Date.parse(entry.validUntil) <= options.now.getTime())
    return deny('autorização desta vaga vencida');
  if (
    Date.parse(entry.reviewedAt) > options.now.getTime() ||
    Date.parse(entry.permission.reviewedAt) > options.now.getTime()
  )
    return deny('revisão da autorização está no futuro');
  const job = options.db
    .prepare('SELECT url, apply_url, description, content_hash FROM jobs WHERE id = ?')
    .get(options.jobId) as
    | { url: string; apply_url: string | null; description: string | null; content_hash: string }
    | undefined;
  if (!job || job.content_hash !== entry.jobContentHash)
    return deny('vaga alterada desde a revisão ou não encontrada');
  if (
    entry.profileHash !== profileHash(options.profile) ||
    entry.cvSha256 !== options.profile.approval?.cvSha256
  )
    return deny('perfil/currículo diverge do que foi autorizado');
  const eligibility = options.db
    .prepare('SELECT verdict, criteria, profile_hash FROM job_eligibility WHERE job_id = ?')
    .get(options.jobId) as { verdict: string; criteria: string; profile_hash: string } | undefined;
  if (
    !eligibility ||
    eligibility.verdict !== 'apto' ||
    eligibility.profile_hash !== profileHash(options.profile)
  )
    return deny('AUTO_APPLY exige elegibilidade apta e atual, sem tolerar requisitos incertos');
  const criteria = JSON.parse(eligibility.criteria) as { kind: string; outcome: string }[];
  if (criteria.some((c) => c.kind === 'obrigatorio' && c.outcome !== 'atende'))
    return deny('há requisito obrigatório incerto ou não atendido');
  if (!entry.noAdditionalQuestionsOrConsents)
    return deny('perguntas ou consentimentos adicionais exigem revisão humana');
  // Nem um e-mail previamente verificado substitui o convite atual escrito na vaga.
  const recipient = candidateEmail(job.description);
  if (!recipient.ok || recipient.email.toLowerCase() !== entry.recipient.toLowerCase())
    return deny('destinatário não corresponde ao convite explícito atual da vaga');
  const selected = usableRecipient(options.db, options.jobId);
  if (selected && selected.email.toLowerCase() !== entry.recipient.toLowerCase())
    return deny('destinatário selecionado diverge do autorizado');
  const application = options.db
    .prepare('SELECT status FROM applications WHERE job_id = ?')
    .get(options.jobId) as { status: string } | undefined;
  if (application && !['preparada', 'aprovada_para_envio'].includes(application.status))
    return deny('já existe envio ou estado incerto; não é reenviado');
  const domain = entry.recipient.split('@')[1]?.toLowerCase();
  if (entry.permission.issuerDomain !== domain)
    return deny('emissor da permissão não corresponde ao domínio do destinatário');
  const sourceHost = new URL(entry.permission.sourceUrl).hostname;
  if (
    sourceHost !== domain &&
    !sourceHost.endsWith(`.${domain}`) &&
    !(entry.permission.kind === 'written_authorization' && sourceHost === 'mail.google.com')
  )
    return deny(
      'fonte da permissão não pertence ao emissor; documentação do Gmail só comprova o transporte',
    );
  try {
    const evidence = readFileSync(resolve(snapshot.directory, entry.permission.artifactPath));
    if (evidence.length < 20 || hash(evidence) !== entry.permission.artifactSha256)
      return deny('artefato de permissão ausente, vazio ou alterado');
  } catch {
    return deny('artefato de permissão não pode ser conferido');
  }
  return {
    ok: true,
    reason: 'envio por e-mail autorizado com evidência revisada e escopo íntegro',
    manifestSha256: snapshot.sha256,
    permissionSha256: entry.permission.artifactSha256,
  };
}

export function autoApplyStates(db: Db): {
  jobId: number;
  title: string;
  state: 'descoberta' | 'preparada' | 'enviada' | 'confirmada' | 'pendente_humano';
}[] {
  return db
    .prepare(
      `SELECT j.id AS jobId, j.title,
    CASE WHEN a.status = 'entrega_confirmada' THEN 'confirmada'
      WHEN a.status = 'enviada' THEN 'enviada'
      WHEN a.status IN ('enviando','pendente_intervencao_humana','falhou') THEN 'pendente_humano'
      WHEN a.status IN ('preparada','aprovada_para_envio') THEN 'preparada'
      WHEN q.status = 'pendente_humano' THEN 'pendente_humano'
      WHEN EXISTS (SELECT 1 FROM autonomous_decisions d WHERE d.job_id = j.id AND d.id = (SELECT MAX(d2.id) FROM autonomous_decisions d2 WHERE d2.job_id = j.id) AND d.decision IN ('pendente','pendente_canal','envio_incerto')) THEN 'pendente_humano'
      ELSE 'descoberta' END AS state
    FROM jobs j LEFT JOIN applications a ON a.job_id = j.id LEFT JOIN autonomous_queue q ON q.job_id = j.id ORDER BY j.id`,
    )
    .all() as ReturnType<typeof autoApplyStates>;
}
