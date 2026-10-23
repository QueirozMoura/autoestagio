import { classifyAttachment } from '../cv/attachments.js';
import { usableRecipient } from './recipients.js';
import { confirmationCode, preflight, type Check, type EmailContext } from './send.js';

/**
 * Prévia final de um envio REAL, para revisão humana no terminal. Usa os mesmos dados e as mesmas verificações do
 * envio (`preflight`). Somente leitura: não grava nada nem registra evento. Contém o destinatário completo e o
 * corpo da mensagem: não deve ser enviada para logs, arquivos de diagnóstico nem saídas JSON.
 */
export interface FinalPreview {
  applicationId: number;
  job: { title: string; company: string | null };
  /** Presente quando há um destinatário verificado utilizável. */
  recipient?: { email: string; source: string; sourceUrl: string };
  /** Presentes quando a mensagem pôde ser montada. */
  subject?: string;
  body?: string;
  attachment?: {
    source: 'mestre' | 'personalizado';
    variant: string | null;
    name: string;
    bytes: number;
    pages?: number;
    sha8: string;
  };
  checks: Check[];
  /** Verificações centrais ok (a mensagem pôde ser montada). */
  ok: boolean;
  /** Portões de envio (teste prévio, intervalo, destinatário repetido) satisfeitos. */
  gatesOk: boolean;
  /** Código de confirmação do conteúdo atual; só existe quando a mensagem pôde ser montada. */
  code?: string;
}

export function buildFinalPreview(ctx: EmailContext, applicationId: number): FinalPreview {
  const result = preflight(ctx, applicationId, 'real');
  const job = ctx.db
    .prepare(
      'SELECT j.title AS title, j.company AS company FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?',
    )
    .get(applicationId) as { title: string; company: string | null };
  const jobId = (
    ctx.db.prepare('SELECT job_id AS id FROM applications WHERE id = ?').get(applicationId) as {
      id: number;
    }
  ).id;
  const verified = usableRecipient(ctx.db, jobId);
  const plan = result.plan;
  let pages: number | undefined;
  if (plan?.attachmentSource === 'personalizado') {
    const classification = classifyAttachment(ctx.db, applicationId);
    if (classification.kind === 'aprovado') {
      pages = (
        ctx.db
          .prepare('SELECT pages FROM cv_artifacts WHERE id = ?')
          .get(classification.link.artifactId) as { pages: number } | undefined
      )?.pages;
    }
  }
  return {
    applicationId,
    job,
    ...(verified === undefined
      ? {}
      : {
          recipient: {
            email: verified.email,
            source:
              verified.sourceKind === 'vaga_oficial' ? 'vaga oficial' : 'página oficial da empresa',
            sourceUrl: verified.sourceUrl,
          },
        }),
    ...(plan === undefined
      ? {}
      : {
          subject: plan.subject,
          body: plan.body,
          attachment: {
            source: plan.attachmentSource,
            variant: plan.attachmentVariant,
            name: plan.cvName,
            bytes: plan.cvBytes.length,
            ...(pages === undefined ? {} : { pages }),
            sha8: plan.cvSha256.slice(0, 8),
          },
          code: confirmationCode(plan.bindingHash),
        }),
    checks: result.checks,
    ok: result.ok,
    gatesOk: result.gatesOk,
  };
}

const mark = (check: Check): string =>
  check.ok
    ? '[ok]       '
    : check.sendOnly === true
      ? '[AVISO]    '
      : check.gate === true
        ? '[PENDENTE] '
        : '[FALHA]    ';

/** Texto para o terminal (revisão humana). Não deve ser registrado em arquivos nem logs. */
export function formatFinalPreview(preview: FinalPreview): string {
  const lines = [
    `PRÉVIA FINAL — candidatura #${preview.applicationId} (envio real)`,
    '  NADA FOI ENVIADO. Esta tela é só para a sua revisão; não é registrada em arquivos nem em logs.',
    '',
    `Vaga: ${preview.job.title}`,
    `Empresa: ${preview.job.company ?? '(não informada)'}`,
    preview.recipient === undefined
      ? 'Destinatário: (nenhum destinatário verificado)'
      : `Destinatário: ${preview.recipient.email}\n  Fonte oficial: ${preview.recipient.source} — ${preview.recipient.sourceUrl}`,
  ];
  if (
    preview.subject !== undefined &&
    preview.body !== undefined &&
    preview.attachment !== undefined
  ) {
    const a = preview.attachment;
    lines.push(
      `Assunto: ${preview.subject}`,
      '',
      '--- corpo da mensagem ---',
      preview.body,
      '--- fim do corpo ---',
      '',
      `Anexo: ${a.name}`,
      `  Origem: ${a.source === 'personalizado' ? `currículo personalizado aprovado (${a.variant ?? ''})` : 'currículo mestre aprovado'}`,
      `  Tamanho: ${a.bytes} bytes${a.pages === undefined ? '' : `; páginas: ${a.pages}`}; identificador do PDF: ${a.sha8}`,
    );
  } else {
    lines.push('', 'A mensagem NÃO pôde ser montada: resolva as verificações abaixo.');
  }
  lines.push(
    '',
    'Verificações:',
    ...preview.checks.map((c) => `  ${mark(c)}${c.id}: ${c.detail}`),
    '',
  );
  if (preview.code === undefined) {
    lines.push('Código de confirmação: indisponível até que as verificações centrais passem.');
  } else {
    lines.push(
      `Código de confirmação: ${preview.code}`,
      '  Ele muda se o destinatário, o corpo, o anexo ou o vínculo mudarem. Confira tudo acima antes de usá-lo.',
      preview.gatesOk
        ? `Para autorizar UM envio: email authorize ${preview.applicationId} --reason "..." --confirm ${preview.code}`
        : 'Há pendências de envio (itens [PENDENTE]); a autorização só é criada quando todas passarem.',
    );
  }
  return lines.join('\n');
}
