import { readFileSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig, loadProfile } from '../config/index.js';
import type { Db } from '../db/index.js';
import {
  LEAD_CHANNELS,
  LEAD_SOURCES,
  LEAD_STATUSES,
  LeadError,
  addLead,
  assessLead,
  importLeads,
  listLeads,
  updateLead,
  type LeadRow,
} from '../discovery/leads.js';

interface Deps {
  withDb: <T>(fn: (db: Db) => T) => T;
  parseId: (value: string) => number;
}

const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_IMPORT_ITEMS = 500;

const OUTCOME: Record<string, string> = {
  atende: 'ok',
  nao_atende: 'NÃO',
  indeterminado: 'a confirmar',
};

export function formatLeads(
  rows: readonly LeadRow[],
  assess: (lead: LeadRow) => ReturnType<typeof assessLead> | undefined,
): string {
  if (rows.length === 0) return 'Nenhum lead.';
  return [
    'Leads de alertas (pistas: NÃO são vagas oficiais nem candidaturas; canal de candidatura só você confirma):',
    ...rows.map((lead) => {
      const a = assess(lead);
      return [
        `  #${lead.id} [${lead.status}] ${lead.title} — ${lead.company ?? '?'} (${lead.location ?? 'local n/i'}; ${lead.work_mode ?? 'modalidade n/i'}; bolsa ${lead.stipend_text ?? 'n/i'}) via ${lead.source}; canal: ${lead.channel}`,
        a === undefined
          ? ''
          : `      área: ${OUTCOME[a.area] ?? a.area} | local/deslocamento: ${OUTCOME[a.location] ?? a.location} | bolsa: ${OUTCOME[a.stipend] ?? a.stipend} | veredito parcial: ${a.verdict === 'inapto' ? 'INAPTO' : 'revisão humana'}`,
      ]
        .filter((line) => line !== '')
        .join('\n');
    }),
  ].join('\n');
}

/** Leads de alertas: pistas de vagas. Nenhum comando daqui envia e-mail, cria candidatura ou fala com o Gmail. */
export function registerLeadCommands(program: Command, { withDb, parseId }: Deps): void {
  const leads = program
    .command('leads')
    .description(
      'Pistas de vagas vindas de alertas (Indeed, LinkedIn): não são vagas oficiais nem candidaturas',
    );

  leads
    .command('add')
    .description('Registra um lead (nada é enviado; e-mail de recrutador nunca é deduzido)')
    .requiredOption('--fonte <fonte>', `origem (${LEAD_SOURCES.join(', ')})`)
    .requiredOption('--titulo <texto>', 'título da vaga')
    .option('--empresa <texto>', 'empresa')
    .option('--local <texto>', 'local como no alerta')
    .option('--modalidade <m>', 'remoto, hibrido ou presencial (só se o alerta informar)')
    .option('--bolsa <texto>', 'bolsa como publicada (ex.: "R$ 1.500 por mês")')
    .option('--url <https>', 'link OFICIAL da vaga (a query e o fragmento são removidos)')
    .option('--recebido-em <AAAA-MM-DD>', 'data do alerta')
    .option('--nota <texto>', 'observação (até 300 caracteres)')
    .action(
      (options: {
        fonte: string;
        titulo: string;
        empresa?: string;
        local?: string;
        modalidade?: string;
        bolsa?: string;
        url?: string;
        recebidoEm?: string;
        nota?: string;
      }) => {
        const result = withDb((db) =>
          addLead(db, {
            source: options.fonte,
            title: options.titulo,
            ...(options.empresa === undefined ? {} : { company: options.empresa }),
            ...(options.local === undefined ? {} : { location: options.local }),
            ...(options.modalidade === undefined ? {} : { workMode: options.modalidade }),
            ...(options.bolsa === undefined ? {} : { stipendText: options.bolsa }),
            ...(options.url === undefined ? {} : { url: options.url }),
            ...(options.recebidoEm === undefined ? {} : { receivedOn: options.recebidoEm }),
            ...(options.nota === undefined ? {} : { note: options.nota }),
          }),
        );
        console.log(
          result.created
            ? `Lead #${result.id} registrado.`
            : `Lead já registrado (#${result.id}); nada mudou.`,
        );
      },
    );

  leads
    .command('import <arquivo>')
    .description(
      'Importa leads de um arquivo JSON (lista de objetos com fonte, título, empresa, local...)',
    )
    .action((file: string) => {
      let items: unknown;
      try {
        const info = statSync(file);
        if (!info.isFile() || info.size > MAX_IMPORT_BYTES) throw new Error('arquivo inadequado');
        items = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        throw new Error(
          'O arquivo não existe, é grande demais (máx. 1 MiB) ou não é um JSON válido.',
          {
            cause: undefined,
          },
        );
      }
      if (!Array.isArray(items)) throw new Error('O arquivo precisa conter uma lista de leads.');
      if (items.length > MAX_IMPORT_ITEMS)
        throw new Error(`Máximo de ${MAX_IMPORT_ITEMS} leads por arquivo. Nada foi importado.`);
      try {
        const result = withDb((db) => importLeads(db, items as unknown[]));
        console.log(`Importados: ${result.created}; já existiam: ${result.duplicates}.`);
      } catch (error) {
        if (error instanceof LeadError)
          throw new Error(`${error.message} Nada foi importado.`, { cause: error });
        throw error;
      }
    });

  leads
    .command('list')
    .description(
      'Lista os leads com a avaliação parcial (título, local/deslocamento e bolsa); nunca "apto"',
    )
    .option('--estado <estado>', `filtra por estado (${LEAD_STATUSES.join(', ')})`)
    .option('--json', 'saída em JSON')
    .action((options: { estado?: string; json?: boolean }) => {
      if (
        options.estado !== undefined &&
        !(LEAD_STATUSES as readonly string[]).includes(options.estado)
      )
        throw new Error(`Estado inválido. Use ${LEAD_STATUSES.join(', ')}.`);
      const profile = loadProfile(loadConfig().profilePath);
      const rows = withDb((db) =>
        listLeads(
          db,
          options.estado === undefined ? {} : { status: options.estado as LeadRow['status'] },
        ),
      );
      const assess = (lead: LeadRow) =>
        profile === undefined ? undefined : assessLead(profile, lead);
      console.log(
        options.json === true
          ? JSON.stringify(
              rows.map((lead) => ({ ...lead, assessment: assess(lead) })),
              null,
              2,
            )
          : formatLeads(rows, assess),
      );
    });

  leads
    .command('set <id>')
    .description(
      'Atualiza o estado, o canal (confirmado POR VOCÊ na página oficial) ou a nota de um lead',
    )
    .option('--estado <estado>', `novo estado (${LEAD_STATUSES.join(', ')})`)
    .option('--canal <canal>', `canal confirmado (${LEAD_CHANNELS.join(', ')})`)
    .option('--nota <texto>', 'observação (até 300 caracteres)')
    .action((id: string, options: { estado?: string; canal?: string; nota?: string }) => {
      try {
        withDb((db) => {
          updateLead(db, parseId(id), {
            ...(options.estado === undefined
              ? {}
              : { status: options.estado as LeadRow['status'] }),
            ...(options.canal === undefined
              ? {}
              : { channel: options.canal as LeadRow['channel'] }),
            ...(options.nota === undefined ? {} : { note: options.nota }),
          });
        });
      } catch (error) {
        if (error instanceof LeadError) throw new Error(error.message, { cause: error });
        throw error;
      }
      console.log(`Lead #${id} atualizado.`);
    });
}
