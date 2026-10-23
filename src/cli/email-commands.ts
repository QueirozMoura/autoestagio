import type { Command } from 'commander';
import { getApplication, getHistory } from '../applications/index.js';
import { loadConfig, loadProfile, type AppConfig, type Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import {
  GmailTransport,
  RecipientError,
  TokenProvider,
  TokenStore,
  approveForSending,
  authorizeSend,
  buildFinalPreview,
  dryRunEmail,
  exportEml,
  formatFinalPreview,
  extractEmails,
  isFreemail,
  listDispatches,
  listRecipients,
  loadEmailConfig,
  loadOAuthClient,
  maskEmail,
  recordConfirmation,
  recoverEmailDispatches,
  resolveRecipientRequirement,
  resolveUnknownDispatch,
  revokeAndDelete,
  sendEmail,
  startLogin,
  verifyRecipientFromJob,
  verifyRecipientFromPage,
  type DispatchKind,
  type EmailContext,
  type MailTransport,
} from '../email/index.js';
import { createHttpClient, loadSourcesConfig } from '../sources/index.js';
import { resolveFromRoot } from '../utils/paths.js';
import { resolveApprovedAttachment } from './cv-attach.js';
import { strictInputsOptions } from './strict-options.js';
import { formatDispatches, formatDryRun } from './email.js';

interface Deps {
  withDb: <T>(fn: (db: Db) => T) => T;
  withDbAsync: <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
  parseId: (value: string) => number;
}

/** Cria o transporte só no momento do envio: ensaios e consultas nunca tocam em credenciais. */
function lazyTransport(config: AppConfig): MailTransport {
  let real: GmailTransport | undefined;
  return {
    send: async (raw) => {
      try {
        real ??= new GmailTransport(
          new TokenProvider(
            new TokenStore(config.tokenPath),
            loadOAuthClient(config.oauthClientPath),
            fetch,
          ),
          fetch,
        );
      } catch {
        // Falha de configuração: nada foi enviado.
        return { kind: 'rejected', category: 'oauth_configuracao' };
      }
      return real.send(raw);
    },
  };
}

export function buildContext(db: Db, config: AppConfig, profile: Profile): EmailContext {
  return {
    db,
    profile,
    transport: lazyTransport(config),
    sendEnabled: config.emailSendEnabled,
    maxPerDay: config.maxApplicationsPerDay,
    testMailbox: loadEmailConfig(config.emailConfigPath).testMailbox,
  };
}

/**
 * Contexto de e-mail com o anexo resolvido. Candidatura sem vínculo usa o mestre (nada é regenerado);
 * com vínculo aprovado, o PDF é regenerado e validado em memória (exige --ancora-sha256). Se a
 * resolução falhar, o motivo é mostrado e o preflight bloqueia: nunca há fallback para o mestre.
 */
export async function contextWithAttachment(
  db: Db,
  config: AppConfig,
  applicationId: number,
  anchorSha256: string | undefined,
): Promise<EmailContext> {
  const base = buildContext(db, config, loadApproved(config));
  const resolved = await resolveApprovedAttachment({
    db,
    applicationId,
    inputs: strictInputsOptions(anchorSha256),
  });
  if (!resolved.ok) {
    console.error(`Anexo: ${resolved.message} (código ${resolved.code})`);
    return base;
  }
  return { ...base, attachment: resolved.attachment };
}

const ANCHOR_OPTION = '--ancora-sha256 <hash>';
const ANCHOR_HELP =
  'SHA-256 do arquivo de âncora (necessário só se a candidatura tem vínculo de currículo aprovado)';

export function loadApproved(config: AppConfig): Profile {
  const profile = loadProfile(config.profilePath);
  if (profile === undefined) throw new Error('Perfil não encontrado.');
  if (profile.approval === undefined)
    throw new Error('O perfil ainda não foi aprovado (approval ausente).');
  return profile;
}

export function registerEmailCommands(
  program: Command,
  { withDb, withDbAsync, parseId }: Deps,
): void {
  const email = program
    .command('email')
    .description(
      'Canal de e-mail (Gmail): ensaio, autorização e envio. Dry-run é o padrão; nada sai sem autorização.',
    );

  // ---------------------------------------------------------------- OAuth
  const auth = email
    .command('auth')
    .description('Login OAuth 2.0 do Gmail (escopo mínimo: gmail.send)');

  auth
    .command('login')
    .description(
      'Abre o fluxo OAuth (PKCE, redirecionamento em 127.0.0.1) e guarda o token localmente (0600)',
    )
    .action(async () => {
      const config = loadConfig();
      const client = loadOAuthClient(config.oauthClientPath);
      const flow = await startLogin({
        client,
        store: new TokenStore(config.tokenPath),
        fetchFn: fetch,
      });
      console.log(
        'Abra este endereço no navegador, escolha a conta e autorize o envio de e-mails (somente "enviar"):\n',
      );
      console.log(flow.authUrl);
      console.log('\nAguardando a autorização (5 min)...');
      await flow.completed;
      console.log(
        'Login concluído. Token salvo em arquivo local com permissão 0600 (nunca exibido).',
      );
    });

  auth
    .command('status')
    .description('Mostra se há login (sem exibir tokens)')
    .action(() => {
      const config = loadConfig();
      const store = new TokenStore(config.tokenPath);
      const token = store.read();
      console.log(
        token === undefined
          ? 'Sem login do Gmail. Rode "email auth login".'
          : `Login presente | escopo: ${token.scope}`,
      );
      console.log(
        `Envio de e-mails: ${config.emailSendEnabled ? 'LIGADO (EMAIL_SEND_ENABLED=true)' : 'desligado (EMAIL_SEND_ENABLED=false)'}`,
      );
    });

  auth
    .command('logout')
    .description('Revoga o acesso no Google e apaga o token local')
    .option('--local-only', 'só apaga o arquivo local, sem falar com o Google')
    .action(async (options: { localOnly?: boolean }) => {
      const config = loadConfig();
      const store = new TokenStore(config.tokenPath);
      if (options.localOnly === true) {
        store.delete();
        console.log(
          'Token local apagado. Revogue também em https://myaccount.google.com/permissions.',
        );
        return;
      }
      const result = await revokeAndDelete(fetch, store);
      console.log(
        result === 'revogado'
          ? 'Acesso revogado no Google e token local apagado.'
          : 'Token local apagado; não foi possível confirmar a revogação. Revogue em https://myaccount.google.com/permissions.',
      );
    });

  // ---------------------------------------------------------------- destinatários
  const recipient = email
    .command('recipient')
    .description('Destinatários verificados (nunca adivinhados)');

  recipient
    .command('scan <id>')
    .description('Lista endereços escritos na descrição da vaga oficial (mascarados)')
    .action((id: string) => {
      const found = withDb((db) => {
        const application = getApplication(db, parseId(id));
        if (application === undefined) throw new Error(`Candidatura ${id} não encontrada.`);
        const job = db
          .prepare('SELECT description FROM jobs WHERE id = ?')
          .get(application.jobId) as { description: string | null };
        return extractEmails(job.description ?? '');
      });
      console.log(
        found.length === 0
          ? 'Nenhum e-mail escrito na vaga. Use "email recipient add" com uma página oficial da empresa.'
          : found
              .map(
                (address) =>
                  `  ${maskEmail(address)}${isFreemail(address) ? '  (provedor gratuito: exige --confirm-freemail)' : ''}`,
              )
              .join('\n'),
      );
    });

  recipient
    .command('add <id>')
    .description(
      'Verifica um destinatário: precisa estar na vaga oficial (--from-job) ou numa página oficial (--page + --company-domain)',
    )
    .requiredOption('--email <endereco>', 'endereço a verificar')
    .option('--from-job', 'procura o endereço na descrição da vaga oficial')
    .option('--page <url>', 'página HTTPS do domínio oficial da empresa onde o endereço aparece')
    .option('--company-domain <dominio>', 'domínio próprio da empresa (ex.: empresa.com.br)')
    .option(
      '--confirm-freemail',
      'confirma que um endereço de provedor gratuito é o contato oficial da vaga',
    )
    .action(
      async (
        id: string,
        options: {
          email: string;
          fromJob?: boolean;
          page?: string;
          companyDomain?: string;
          confirmFreemail?: boolean;
        },
      ) => {
        if ((options.fromJob === true) === (options.page !== undefined)) {
          throw new Error(
            'Use exatamente uma fonte: --from-job OU --page <url> com --company-domain.',
          );
        }
        try {
          const verified = await withDbAsync(async (db) => {
            const application = getApplication(db, parseId(id));
            if (application === undefined) throw new Error(`Candidatura ${id} não encontrada.`);
            if (options.fromJob === true) {
              return verifyRecipientFromJob(db, application.jobId, options.email, {
                confirmFreemail: options.confirmFreemail === true,
              });
            }
            if (options.companyDomain === undefined)
              throw new Error('--page exige --company-domain.');
            return verifyRecipientFromPage(db, createHttpClient(loadSourcesConfig()), {
              jobId: application.jobId,
              email: options.email,
              pageUrl: options.page ?? '',
              companyDomain: options.companyDomain,
            });
          });
          // A pendência "destinatario_verificado" do preparo fica resolvida (só registra o fato).
          withDb((db) => {
            resolveRecipientRequirement(db, parseId(id));
          });
          console.log(
            `Destinatário ${maskEmail(verified.email)} verificado (${verified.sourceKind === 'vaga_oficial' ? 'vaga oficial' : 'página oficial da empresa'}).`,
          );
        } catch (error) {
          if (error instanceof RecipientError) {
            console.error(`Destinatário NÃO verificado (${error.code}): ${error.message}`);
            process.exitCode = 1;
            return;
          }
          throw error;
        }
      },
    );

  recipient
    .command('list <id>')
    .description('Lista os destinatários verificados da vaga (mascarados)')
    .action((id: string) => {
      const items = withDb((db) => {
        const application = getApplication(db, parseId(id));
        if (application === undefined) throw new Error(`Candidatura ${id} não encontrada.`);
        return listRecipients(db, application.jobId);
      });
      console.log(
        items.length === 0
          ? 'Nenhum destinatário verificado.'
          : items
              .map(
                (r) =>
                  `  ${maskEmail(r.email)} | ${r.sourceKind} | ${r.sourceUrl}${r.freemail ? ` | provedor gratuito (${r.freemailConfirmed ? 'confirmado' : 'NÃO confirmado'})` : ''}`,
              )
              .join('\n'),
      );
    });

  // ---------------------------------------------------------------- fluxo de envio
  const kindOf = (test?: boolean): DispatchKind => (test === true ? 'teste' : 'real');

  email
    .command('approve <id>')
    .description('Aprova ESTA candidatura para envio real (modo revisao); não envia nada')
    .requiredOption('--reason <motivo>', 'por que você aprova')
    .option(ANCHOR_OPTION, ANCHOR_HELP)
    .action(async (id: string, options: { reason: string; ancoraSha256?: string }) => {
      const config = loadConfig();
      const application = await withDbAsync(async (db) =>
        approveForSending(
          await contextWithAttachment(db, config, parseId(id), options.ancoraSha256),
          parseId(id),
          options.reason,
        ),
      );
      console.log(
        `Candidatura #${application.id} aprovada para envio (modo ${application.mode}). Nada foi enviado.`,
      );
    });

  email
    .command('dry-run <id>')
    .description('Ensaio do envio: verificações + mensagem montada. NUNCA chama o Gmail (padrão)')
    .option('--test', 'ensaia o envio de teste para a sua caixa de teste')
    .option(ANCHOR_OPTION, ANCHOR_HELP)
    .action(async (id: string, options: { test?: boolean; ancoraSha256?: string }) => {
      const config = loadConfig();
      const kind = kindOf(options.test);
      const report = await withDbAsync(async (db) =>
        dryRunEmail(
          await contextWithAttachment(db, config, parseId(id), options.ancoraSha256),
          parseId(id),
          kind,
        ),
      );
      console.log(formatDryRun(report, parseId(id), kind));
      if (!report.ok) process.exitCode = 1;
    });

  email
    .command('preview-final <id>')
    .description(
      'Prévia final do envio REAL para revisão humana (destinatário completo, corpo, anexo e código de confirmação). Não envia nem grava nada',
    )
    .option(ANCHOR_OPTION, ANCHOR_HELP)
    .action(async (id: string, options: { ancoraSha256?: string }) => {
      const config = loadConfig();
      // Sem opção --json de propósito: o endereço completo e o corpo são só para o terminal.
      const preview = await withDbAsync(async (db) =>
        buildFinalPreview(
          await contextWithAttachment(db, config, parseId(id), options.ancoraSha256),
          parseId(id),
        ),
      );
      console.log(formatFinalPreview(preview));
      if (!preview.ok) process.exitCode = 1;
    });

  email
    .command('export-eml <id>')
    .description(
      'Exporta um rascunho LOCAL (.eml) com o anexo correto. NÃO envia, não chama o Gmail e não muda o estado',
    )
    .option('--test', 'exporta a versão de teste (destinatário = sua caixa de teste)')
    .option(
      '--output <diretorio>',
      'diretório de saída (padrão: data/eml-drafts/, criado com 0700); o nome do arquivo é definido pelo programa',
    )
    .option(ANCHOR_OPTION, ANCHOR_HELP)
    .action(
      async (id: string, options: { test?: boolean; output?: string; ancoraSha256?: string }) => {
        const config = loadConfig();
        const kind = kindOf(options.test);
        const dir =
          options.output === undefined ? resolveFromRoot('data/eml-drafts') : options.output;
        const result = await withDbAsync(async (db) =>
          exportEml(
            await contextWithAttachment(db, config, parseId(id), options.ancoraSha256),
            parseId(id),
            kind,
            { dir },
          ),
        );
        console.log(
          [
            `Rascunho local exportado — candidatura #${id} (${kind === 'real' ? 'envio real' : 'TESTE'}).`,
            '  NADA FOI ENVIADO. Nenhuma chamada ao Gmail foi feita; o estado da candidatura não mudou.',
            `  Arquivo: ${result.path}`,
            `  Destinatário: ${result.recipientMasked}`,
            `  Anexo: ${result.attachmentSource === 'personalizado' ? `currículo personalizado (${result.attachmentVariant ?? ''})` : 'currículo mestre'}`,
            result.durable
              ? '  Durabilidade: confirmada'
              : '  Durabilidade: NÃO confirmada (arquivo publicado; fsync do diretório falhou)',
            ...(result.tempCleanup === 'left-behind'
              ? [
                  `  Aviso: sobrou um temporário no diretório (${result.leftoverTemp ?? ''}); remova-o.`,
                ]
              : []),
            '  O arquivo contém dados pessoais: mantenha-o privado.',
          ].join('\n'),
        );
      },
    );

  email
    .command('authorize <id>')
    .description(
      'Autoriza UM envio específico (uso único, vale 30 min, amarrado ao conteúdo atual)',
    )
    .requiredOption(
      '--reason <texto>',
      'sua confirmação, ex.: "autorizo enviar a candidatura #5 para a Acme"',
    )
    .option('--test', 'autoriza o envio de TESTE para a sua caixa')
    .option('--ttl-min <min>', 'validade em minutos (1 a 240)', '30')
    .option(
      '--confirm <codigo>',
      'código de confirmação mostrado por "email preview-final" (obrigatório no envio real)',
    )
    .option(ANCHOR_OPTION, ANCHOR_HELP)
    .action(
      async (
        id: string,
        options: {
          reason: string;
          test?: boolean;
          ttlMin: string;
          confirm?: string;
          ancoraSha256?: string;
        },
      ) => {
        const config = loadConfig();
        const authorization = await withDbAsync(async (db) =>
          authorizeSend(
            await contextWithAttachment(db, config, parseId(id), options.ancoraSha256),
            parseId(id),
            kindOf(options.test),
            options.reason,
            Number(options.ttlMin),
            options.confirm,
          ),
        );
        console.log(
          `Autorização #${authorization.id} criada (${authorization.kind}); vale até ${authorization.expiresAt} e para 1 envio.\n` +
            `Para enviar: email send ${id} --authorization ${authorization.id}${authorization.kind === 'teste' ? ' --test' : ''}`,
        );
      },
    );

  email
    .command('send <id>')
    .description('ENVIA a mensagem (exige EMAIL_SEND_ENABLED=true e uma autorização válida)')
    .requiredOption('--authorization <n>', 'número da autorização criada por "email authorize"')
    .option('--test', 'envio de TESTE para a sua caixa (não altera o estado da candidatura)')
    .option(ANCHOR_OPTION, ANCHOR_HELP)
    .action(
      async (
        id: string,
        options: { authorization: string; test?: boolean; ancoraSha256?: string },
      ) => {
        const config = loadConfig();
        const result = await withDbAsync(async (db) =>
          sendEmail(
            await contextWithAttachment(db, config, parseId(id), options.ancoraSha256),
            parseId(id),
            parseId(options.authorization),
            kindOf(options.test),
          ),
        );
        if (result.outcome === 'aceito') {
          console.log(
            `Aceito pelo Gmail (envio #${result.dispatchId}, id registrado). Isto NÃO confirma entrega nem recebimento pela empresa.`,
          );
        } else if (result.outcome === 'rejeitado') {
          console.log(
            `O Gmail recusou o envio (${result.category}); nada foi enviado. Candidatura marcada como "falhou".`,
          );
          process.exitCode = 1;
        } else {
          console.log(
            `RESULTADO DESCONHECIDO (${result.category}). NÃO REENVIE. Confira a pasta Enviados do Gmail e resolva com "email resolve ${id}".`,
          );
          process.exitCode = 2;
        }
      },
    );

  email
    .command('status <id>')
    .description('Envios e confirmações da candidatura (sem endereços completos, ids nem conteúdo)')
    .action((id: string) => {
      const data = withDb((db) => listDispatches(db, parseId(id)));
      console.log(formatDispatches(data));
    });

  email
    .command('confirm <id>')
    .description(
      'Registra confirmação de entrega ou de recebimento pela empresa (informada por você, com evidência)',
    )
    .requiredOption('--kind <tipo>', 'entrega | recebimento')
    .requiredOption('--evidence <texto>', 'o que comprova (ex.: "resposta do RH em 23/10")')
    .action((id: string, options: { kind: string; evidence: string }) => {
      if (options.kind !== 'entrega' && options.kind !== 'recebimento')
        throw new Error('--kind deve ser "entrega" ou "recebimento".');
      withDb((db) => {
        recordConfirmation(
          db,
          parseId(id),
          options.kind === 'entrega' ? 'entrega' : 'recebimento_empresa',
          options.evidence,
        );
      });
      console.log(`Confirmação de ${options.kind} registrada.`);
    });

  email
    .command('resolve <id>')
    .description('Resolve um envio de resultado desconhecido depois de conferir a pasta Enviados')
    .option('--sent', 'a mensagem SAIU (está em Enviados)')
    .option('--not-sent', 'a mensagem NÃO saiu')
    .requiredOption('--evidence <texto>', 'o que você conferiu')
    .action((id: string, options: { sent?: boolean; notSent?: boolean; evidence: string }) => {
      if ((options.sent === true) === (options.notSent === true))
        throw new Error('Use exatamente um: --sent ou --not-sent.');
      withDb((db) => {
        resolveUnknownDispatch(
          db,
          parseId(id),
          options.sent === true
            ? { sent: true, evidence: options.evidence }
            : { sent: false, evidence: options.evidence },
        );
      });
      console.log(
        options.sent === true
          ? 'Marcada como enviada (confirmado por você).'
          : 'Marcada como falhou: não saiu. Nenhum reenvio automático.',
      );
    });

  email
    .command('recover')
    .description(
      'Move para intervenção humana os envios reservados que ficaram sem resultado (nunca reenvia)',
    )
    .option(
      '--older-than-min <min>',
      'considera interrompidos os envios reservados há mais de n minutos',
      '10',
    )
    .action((options: { olderThanMin: string }) => {
      const ids = withDb((db) =>
        recoverEmailDispatches(db, { olderThanMs: Number(options.olderThanMin) * 60_000 }),
      );
      console.log(
        ids.length === 0
          ? 'Nenhum envio interrompido.'
          : `Envios marcados como desconhecidos: ${ids.map((n) => `#${n}`).join(', ')}. Confira a pasta Enviados e use "email resolve".`,
      );
    });

  email
    .command('history <id>')
    .description('Histórico auditável da candidatura')
    .action((id: string) => {
      const events = withDb((db) => getHistory(db, parseId(id)));
      console.log(
        events
          .map(
            (e) =>
              `${e.createdAt}  ${e.fromStatus ?? '(início)'} → ${e.toStatus}  [${e.actor}]  ${e.reason}`,
          )
          .join('\n') || 'Sem eventos.',
      );
    });
}
