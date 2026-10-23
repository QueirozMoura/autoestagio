import { getApplication } from '../applications/index.js';
import { classifyAttachment } from '../cv/attachments.js';
import type { Db } from '../db/index.js';
import { maskEmail, usableRecipient } from '../email/recipients.js';
import { preflight, type Check, type EmailContext } from '../email/send.js';
import { computeReadiness } from '../preparation/index.js';
import { profileHash as hashProfile } from '../eligibility/index.js';

/**
 * Andamento de uma candidatura, de ponta a ponta. SOMENTE LEITURA: nada é gravado e nada é enviado. As regras
 * vêm de `preflight` (as mesmas do envio); aqui só se organiza o resultado em etapas e se indica o próximo passo.
 * Mostra apenas dados mascarados: nunca o endereço completo, o corpo ou hashes.
 */
export type GateState = 'ok' | 'pendente' | 'bloqueado' | 'nao_se_aplica';
export interface ApplyGate {
  id: string;
  label: string;
  state: GateState;
  detail: string;
}
export interface ApplyStatus {
  jobId: number;
  job: { title: string; company: string | null };
  applicationId?: number;
  applicationStatus?: string;
  applicationMode?: string;
  gates: ApplyGate[];
  /** Todas as etapas (inclusive autorização e trava mestra) permitem o envio agora. */
  sendPossible: boolean;
  next: string;
}

const find = (checks: readonly Check[], id: string): Check | undefined =>
  checks.find((c) => c.id === id);
const gate = (id: string, label: string, state: GateState, detail: string): ApplyGate => ({
  id,
  label,
  state,
  detail,
});
const fromCheck = (
  id: string,
  label: string,
  check: Check | undefined,
  pending = 'pendente',
): ApplyGate =>
  check === undefined
    ? gate(id, label, 'nao_se_aplica', 'verificação indisponível nesta etapa')
    : gate(
        id,
        label,
        check.ok ? 'ok' : pending === 'bloqueado' ? 'bloqueado' : 'pendente',
        check.detail,
      );

export function applyStatus(
  ctx: EmailContext,
  target: { applicationId: number } | { jobId: number },
): ApplyStatus {
  const db: Db = ctx.db;
  const applicationId =
    'applicationId' in target
      ? target.applicationId
      : (
          db.prepare('SELECT id FROM applications WHERE job_id = ?').get(target.jobId) as
            { id: number } | undefined
        )?.id;
  const application = applicationId === undefined ? undefined : getApplication(db, applicationId);
  if ('applicationId' in target && application === undefined)
    throw new Error(`Candidatura ${target.applicationId} não encontrada.`);
  const jobId = application?.jobId ?? (target as { jobId: number }).jobId;
  const job = db.prepare('SELECT title, company FROM jobs WHERE id = ?').get(jobId) as
    { title: string; company: string | null } | undefined;
  if (job === undefined) throw new Error(`Vaga ${jobId} não encontrada.`);

  // Sem candidatura: só a elegibilidade e o primeiro passo.
  if (application === undefined) {
    const eligibility = db
      .prepare('SELECT verdict FROM job_eligibility WHERE job_id = ?')
      .get(jobId) as { verdict: string } | undefined;
    const gates = [
      gate('candidatura', 'Candidatura', 'pendente', 'ainda não existe candidatura para esta vaga'),
      gate(
        'elegibilidade',
        'Elegibilidade',
        eligibility === undefined || eligibility.verdict === 'inapto' ? 'bloqueado' : 'ok',
        eligibility === undefined
          ? 'sem análise: rode "analyze"'
          : `veredito: ${eligibility.verdict}`,
      ),
    ];
    const next =
      eligibility === undefined
        ? 'Rode "analyze" para classificar a vaga.'
        : eligibility.verdict === 'inapto'
          ? 'A vaga é inapta: não é possível preparar a candidatura.'
          : eligibility.verdict === 'revisao_humana'
            ? `Decida se prepara: applications prepare ${jobId} --channel email --override-review "<motivo>"`
            : `applications prepare ${jobId} --channel email`;
    return { jobId, job, gates, sendPossible: false, next };
  }

  const id = application.id;
  const real = preflight(ctx, id, 'real');
  const checks = real.checks;
  const readiness = computeReadiness(db, id, hashProfile(ctx.profile));
  const classification = classifyAttachment(db, id);
  const gates: ApplyGate[] = [];

  gates.push(
    gate(
      'candidatura',
      'Candidatura',
      'ok',
      `estado "${application.status}", modo "${application.mode}"`,
    ),
  );
  const eligibility = find(checks, 'elegibilidade_atual');
  gates.push(
    eligibility === undefined
      ? gate('elegibilidade', 'Elegibilidade', 'pendente', 'indisponível')
      : fromCheck('elegibilidade', 'Elegibilidade', eligibility, 'bloqueado'),
  );
  gates.push(
    gate(
      'rascunho',
      'Rascunho revisado',
      readiness === 'revisada' ? 'ok' : 'pendente',
      `situação do rascunho: ${readiness}`,
    ),
  );
  gates.push(
    fromCheck('destinatario', 'Destinatário verificado', find(checks, 'destinatario_verificado')),
  );

  // Currículo e vínculo.
  const attachmentChecks = [
    'curriculo_confere',
    'anexo_selecionado',
    'vinculo_curriculo',
    'anexo_integro',
  ]
    .map((cid) => find(checks, cid))
    .filter((c): c is Check => c !== undefined);
  const failingAttachment = attachmentChecks.find((c) => !c.ok);
  gates.push(
    classification.kind === 'bloqueado'
      ? gate(
          'curriculo',
          'Currículo do anexo',
          'bloqueado',
          failingAttachment?.detail ?? 'sem vínculo aprovado utilizável',
        )
      : gate(
          'curriculo',
          'Currículo do anexo',
          failingAttachment === undefined ? 'ok' : 'pendente',
          failingAttachment?.detail ??
            (classification.kind === 'mestre'
              ? 'currículo mestre aprovado (sem vínculo personalizado)'
              : `currículo personalizado (${classification.link.variant}) verificado`),
        ),
  );
  gates.push(
    classification.kind === 'mestre'
      ? gate(
          'vinculo',
          'Aprovação do currículo personalizado',
          'nao_se_aplica',
          'candidatura usa o currículo mestre',
        )
      : classification.kind === 'aprovado'
        ? gate(
            'vinculo',
            'Aprovação do currículo personalizado',
            'ok',
            `vínculo aprovado (${classification.link.variant})`,
          )
        : gate(
            'vinculo',
            'Aprovação do currículo personalizado',
            'bloqueado',
            `histórico de vínculo sem aprovação utilizável (${[...new Set(classification.states)].join(', ')})`,
          ),
  );
  gates.push(
    fromCheck('aprovada_para_envio', 'Aprovada para envio', find(checks, 'estado_e_modo')),
  );
  gates.push(
    fromCheck('teste_obrigatorio', 'Envio de teste bem-sucedido', find(checks, 'teste_previo')),
  );
  const limits = [
    'sem_envio_anterior',
    'limite_diario',
    'intervalo_minimo',
    'destinatario_repetido',
  ]
    .map((cid) => find(checks, cid))
    .filter((c): c is Check => c !== undefined);
  const limitFail = limits.find((c) => !c.ok);
  gates.push(
    gate(
      'limites',
      'Limites e duplicação',
      limitFail === undefined ? 'ok' : 'bloqueado',
      limitFail?.detail ?? 'sem envio anterior, intervalo e destinatário livres',
    ),
  );

  // Autorização de uso único vigente e coerente com o conteúdo atual.
  const nowIso = (ctx.now ?? (() => new Date()))().toISOString();
  const open = db
    .prepare(
      "SELECT binding_hash AS hash FROM email_authorizations WHERE application_id = ? AND kind = 'real' AND used_at IS NULL AND expires_at > ?",
    )
    .all(id, nowIso) as { hash: string }[];
  const planHash = real.plan?.bindingHash;
  const coherent = planHash !== undefined && open.some((a) => a.hash === planHash);
  gates.push(
    gate(
      'autorizacao',
      'Autorização de uso único',
      coherent ? 'ok' : 'pendente',
      coherent
        ? 'há uma autorização vigente para o conteúdo atual'
        : open.length > 0
          ? 'há autorização aberta, mas ela NÃO corresponde ao conteúdo atual (não será aceita)'
          : 'nenhuma autorização vigente',
    ),
  );
  gates.push(
    fromCheck(
      'trava_mestra',
      'Trava de envio (EMAIL_SEND_ENABLED)',
      find(checks, 'envio_habilitado'),
    ),
  );

  const sendPossible = real.sendReady && coherent;
  const last = db
    .prepare(
      "SELECT status FROM email_dispatches WHERE application_id = ? AND kind = 'real' ORDER BY id DESC LIMIT 1",
    )
    .get(id) as { status: string } | undefined;

  const recipient = usableRecipient(db, application.jobId);
  const masked = recipient === undefined ? '' : ` (${maskEmail(recipient.email)})`;
  let next: string;
  if (application.status === 'enviada' || application.status === 'entrega_confirmada')
    next =
      'Envio já aceito pelo Gmail. Registre a entrega com "email confirm" quando tiver evidência.';
  else if (application.status === 'enviando')
    next = 'Envio em andamento/interrompido: rode "email recover".';
  else if (application.status === 'pendente_intervencao_humana' || last?.status === 'desconhecido')
    next = `Resultado incerto: NÃO reenvie. Confira a pasta Enviados e rode: email resolve ${id} --sent|--not-sent --evidence "..."`;
  else if (application.status === 'falhou')
    next =
      'O envio falhou e nada saiu. Refaça o preparo (applications prepare) com uma decisão sua.';
  else if (eligibility?.ok === false)
    next = 'A elegibilidade não está válida: rode "analyze" e reveja a vaga.';
  else if (readiness !== 'revisada')
    next =
      readiness === 'pronta_para_revisao'
        ? `Revise com "applications preview ${id}" e confirme com "applications confirm-review ${id}".`
        : `Resolva o rascunho (${readiness}): applications preview ${id} / applications answer / applications prepare --regenerate.`;
  else if (find(checks, 'destinatario_verificado')?.ok === false)
    next = `Verifique um destinatário: email recipient scan ${id} e email recipient add ${id} --email <endereço> --from-job`;
  else if (classification.kind === 'bloqueado')
    next = `Há histórico de vínculo sem aprovação: cv attach --application ${id} --variant <id> --ancora-sha256 <hash> e depois cv attachment approve ${id}`;
  else if (classification.kind === 'aprovado' && failingAttachment !== undefined)
    next = `Informe a âncora (--ancora-sha256) para verificar o currículo personalizado: ${failingAttachment.id}`;
  else if (failingAttachment !== undefined)
    next = `Resolva a verificação do currículo: ${failingAttachment.id}`;
  else if (application.status === 'preparada')
    next = `Opcional: cv attach --application ${id} --variant <id> ... (currículo personalizado). Depois: email approve ${id} --reason "..."`;
  else if (find(checks, 'teste_previo')?.ok === false)
    next = `Faça o teste: email authorize ${id} --test --reason "..." e email send ${id} --authorization <n> --test (vai só para a sua caixa de teste)`;
  else if (limitFail !== undefined) next = `Aguarde/resolva: ${limitFail.detail}`;
  else if (!coherent)
    next = `Revise tudo com "email preview-final ${id}" e autorize: email authorize ${id} --reason "..." --confirm <código>${masked}`;
  else if (!real.sendReady)
    next =
      'Tudo pronto. A trava EMAIL_SEND_ENABLED está desligada; ligue-a somente na execução autorizada do envio.';
  else next = `Pronto para enviar, com a sua decisão: email send ${id} --authorization <n>`;

  return {
    jobId,
    job,
    applicationId: id,
    applicationStatus: application.status,
    applicationMode: application.mode,
    gates,
    sendPossible,
    next,
  };
}

const MARK: Record<GateState, string> = {
  ok: '[ok]       ',
  pendente: '[PENDENTE] ',
  bloqueado: '[BLOQUEIO] ',
  nao_se_aplica: '[n/a]      ',
};

export function formatApplyStatus(status: ApplyStatus): string {
  return [
    status.applicationId === undefined
      ? `Vaga #${status.jobId} — sem candidatura`
      : `Candidatura #${status.applicationId} (vaga #${status.jobId})`,
    `  Vaga: ${status.job.title}${status.job.company === null ? '' : ` — ${status.job.company}`}`,
    '  SOMENTE LEITURA: nada foi enviado ou alterado.',
    '',
    ...status.gates.map((g) => `  ${MARK[g.state]}${g.label}: ${g.detail}`),
    '',
    `Envio possível agora: ${status.sendPossible ? 'SIM (ainda depende da sua decisão de enviar)' : 'NÃO'}`,
    `Próxima ação: ${status.next}`,
  ].join('\n');
}
