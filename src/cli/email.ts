import type { Check, DispatchView, DryRunReport } from '../email/index.js';

const mark = (check: Check): string =>
  check.ok ? '[ok]    ' : check.sendOnly === true ? '[AVISO] ' : '[FALHA] ';

export function formatChecks(checks: readonly Check[]): string {
  return checks.map((check) => `  ${mark(check)}${check.id}: ${check.detail}`).join('\n');
}

/** Saída do ensaio de envio. Nunca mostra o endereço completo, o corpo da mensagem nem tokens. */
export function formatDryRun(
  report: DryRunReport,
  applicationId: number,
  kind: 'real' | 'teste',
): string {
  const lines = [
    `Ensaio de envio por e-mail — candidatura #${applicationId} (${kind === 'real' ? 'envio real' : 'envio de TESTE'})`,
    '  NADA FOI ENVIADO. Nenhuma chamada ao Gmail foi feita.',
    '',
    formatChecks(report.checks),
    '',
  ];
  if (report.message === undefined) {
    lines.push('Mensagem não montada: resolva as verificações com [FALHA].');
  } else {
    const m = report.message;
    lines.push(
      'Mensagem montada (MIME) com sucesso:',
      `  destinatário: ${m.recipientMasked}`,
      `  assunto: ${m.subject}`,
      `  anexo: ${m.attachmentName} (${m.attachmentBytes} bytes, SHA-256 ${m.attachmentSha256Prefix}…)`,
      `  tamanho total: ${m.mimeBytes} bytes`,
    );
  }
  lines.push(
    '',
    report.sendReady
      ? 'Tudo pronto para o envio: falta só a sua autorização específica ("email authorize").'
      : report.ok
        ? 'Verificações ok, mas a trava mestra está desligada (EMAIL_SEND_ENABLED=false): nenhum envio é possível.'
        : 'Há verificações falhando: o envio está bloqueado.',
  );
  return lines.join('\n');
}

export function formatDispatches(data: {
  dispatches: DispatchView[];
  confirmations: { kind: string; by: string; at: string }[];
}): string {
  const lines: string[] = [];
  if (data.dispatches.length === 0) lines.push('Nenhum envio registrado.');
  for (const d of data.dispatches) {
    lines.push(
      `envio #${d.id} [${d.kind}] ${d.status} → ${d.recipientMasked} | id do Gmail: ${d.hasGmailMessageId ? 'registrado' : 'não'}${d.errorCategory === null ? '' : ` | ${d.errorCategory}`} | reservado em ${d.reservedAt}`,
    );
  }
  lines.push('', 'Confirmações (três coisas diferentes):');
  const has = (kind: string): string => {
    const found = data.confirmations.find((c) => c.kind === kind);
    return found === undefined ? 'não' : `sim (${found.by}, ${found.at})`;
  };
  lines.push(
    `  aceito pelo Gmail:           ${has('aceito_pelo_gmail')}`,
    `  entrega confirmada:          ${has('entrega')}`,
    `  recebimento pela empresa:    ${has('recebimento_empresa')}`,
  );
  return lines.join('\n');
}
