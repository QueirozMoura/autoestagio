import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerLeadCommands } from '../../src/cli/leads.js';
import {
  DEFAULT_MIGRATIONS_DIR,
  IN_MEMORY,
  openDatabase,
  runMigrations,
  type Db,
} from '../../src/db/index.js';
import {
  LeadError,
  addLead,
  assessLead,
  importLeads,
  leadKey,
  listLeads,
  sanitizeUrl,
  updateLead,
  type LeadRow,
} from '../../src/discovery/leads.js';
import { seedJob } from '../helpers/applications.js';
import { profile } from '../helpers/eligibility.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});
const NOW = new Date('2026-10-23T12:00:00Z');
const lead = (over: Record<string, unknown> = {}) => ({
  source: 'indeed',
  title: 'Estágio em Help Desk',
  company: 'Avita',
  location: 'São Paulo, SP',
  ...over,
});

describe('migração 0010 (job_leads)', () => {
  it('é aditiva: não altera dados existentes e não liga leads a vagas, candidaturas ou envios', () => {
    const old = openDatabase(IN_MEMORY);
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    dirs.push(dir);
    for (const name of readdirSync(DEFAULT_MIGRATIONS_DIR))
      if (name < '0010') copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(dir, name));
    runMigrations(old, dir);
    seedJob(old, { title: 'Estágio Existente' });
    const before = old.prepare('SELECT * FROM jobs').all();
    expect(runMigrations(old)).toEqual([
      '0010_job_leads.sql',
      '0011_autonomous_runs.sql',
      '0012_autonomous_grants.sql',
    ]);
    expect(runMigrations(old)).toEqual([]);
    expect(old.prepare('SELECT * FROM jobs').all()).toEqual(before);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect(old.pragma('foreign_key_list(job_leads)')).toEqual([]);
    expect((old.prepare('SELECT COUNT(*) AS n FROM job_leads').get() as { n: number }).n).toBe(0);
    const columns = (old.pragma('table_info(job_leads)') as { name: string }[]).map((c) => c.name);
    expect(columns).not.toEqual(expect.arrayContaining(['job_id']));
    expect(columns.join(',')).not.toMatch(/email|application|recipient/u);
    old.close();
  });

  it('restrições do banco: fonte, modalidade, canal sem "e-mail", estado, URL sem rastreamento e datas', () => {
    const insert = (over: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO job_leads (source, title, lead_key, work_mode, channel, status, url, received_on, created_at, updated_at)
         VALUES (@source, 'T', @key, @mode, @channel, @status, @url, @received, 'a', 'a')`,
        )
        .run({
          source: 'indeed',
          key: 'k'.repeat(32),
          mode: null,
          channel: 'desconhecido',
          status: 'nova',
          url: null,
          received: null,
          ...over,
        });
    expect(() => insert({})).not.toThrow();
    expect(() => insert({ source: 'facebook', key: 'a'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ mode: 'hibrida', key: 'b'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ channel: 'email', key: 'c'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ channel: 'email_oficial', key: 'c'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ status: 'aprovada', key: 'd'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ url: 'http://x.com/a', key: 'e'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ url: 'https://x.com/a?utm=1', key: 'f'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ received: '23/10/2026', key: 'g'.repeat(32) })).toThrow(/CHECK/);
    expect(() => insert({ key: 'curta' })).toThrow(/CHECK/);
    expect(() => insert({})).toThrow(/UNIQUE/);
  });
});

describe('registro e deduplicação', () => {
  it('registra, normaliza espaços e não duplica o mesmo lead (mesma fonte)', () => {
    const first = addLead(db, lead({ title: '  Estágio   em Help Desk ' }), NOW);
    expect(first.created).toBe(true);
    expect(addLead(db, lead({ title: 'estágio em help desk', company: 'AVITA' }), NOW)).toEqual({
      id: first.id,
      created: false,
    });
    expect(addLead(db, lead({ source: 'linkedin' }), NOW).created).toBe(true);
    expect(listLeads(db)).toHaveLength(2);
    expect(listLeads(db)[0]).toMatchObject({
      title: 'Estágio em Help Desk',
      channel: 'desconhecido',
      status: 'nova',
    });
    expect(leadKey('A', 'B', 'C')).toHaveLength(32);
  });

  it('valida a entrada e rejeita campos desconhecidos', () => {
    for (const bad of [
      { ...lead(), source: 'x' },
      { ...lead(), title: '' },
      { ...lead(), workMode: 'hibrida' },
      { ...lead(), receivedOn: '2026/10/23' },
      { ...lead(), email: 'rh@x.com' },
      { ...lead(), recruiterEmail: 'a@b.com' },
    ])
      expect(() => addLead(db, bad)).toThrow(LeadError);
    expect(listLeads(db)).toEqual([]);
  });

  it('remove query e fragmento da URL (links de alerta são pessoais) e exige HTTPS', () => {
    expect(sanitizeUrl('https://empresa.com.br/carreiras/vaga-1?token=abc#x')).toBe(
      'https://empresa.com.br/carreiras/vaga-1',
    );
    expect(() => sanitizeUrl('http://empresa.com/x')).toThrow(/HTTPS/);
    expect(() => sanitizeUrl('não é url')).toThrow(/inválida/);
    const { id } = addLead(
      db,
      lead({ url: 'https://empresa.com.br/vaga?utm_source=indeed&jk=123' }),
      NOW,
    );
    expect(listLeads(db).find((l) => l.id === id)?.url).toBe('https://empresa.com.br/vaga');
  });

  it('a importação é atômica: um item inválido cancela todos', () => {
    expect(() =>
      importLeads(db, [lead(), lead({ title: 'Outro' }), { ...lead(), source: 'x' }], NOW),
    ).toThrow(LeadError);
    expect(listLeads(db)).toEqual([]);
    expect(importLeads(db, [lead(), lead({ title: 'Outro' }), lead()], NOW)).toEqual({
      created: 2,
      duplicates: 1,
    });
  });

  it('estado e canal só mudam por decisão explícita; canal nunca é e-mail', () => {
    const { id } = addLead(db, lead(), NOW);
    updateLead(
      db,
      id,
      { channel: 'formulario', status: 'em_analise', note: 'Confirmado na página da empresa' },
      NOW,
    );
    expect(listLeads(db, { status: 'em_analise' })[0]).toMatchObject({
      channel: 'formulario',
      note: 'Confirmado na página da empresa',
    });
    expect(() => {
      updateLead(db, id, { channel: 'email' as never });
    }).toThrow(LeadError);
    expect(() => {
      updateLead(db, 999, { status: 'descartada' });
    }).toThrow(/não encontrado/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
  });
});

describe('validação de entrada', () => {
  it('rejeita título só com espaços/controle e remove caracteres de controle', () => {
    expect(() => addLead(db, lead({ title: '  \u001b  ' }), NOW)).toThrow(/título vazio/);
    const { id } = addLead(db, lead({ title: 'Help\u001b[31m Desk', company: '   ' }), NOW);
    expect(listLeads(db).find((row) => row.id === id)).toMatchObject({
      title: 'Help [31m Desk',
      company: null,
    });
  });

  it('limita a nota a 300 caracteres na atualização, sem erro bruto do banco', () => {
    const { id } = addLead(db, lead(), NOW);
    expect(() => {
      updateLead(db, id, { note: 'x'.repeat(301) }, NOW);
    }).toThrow(LeadError);
  });
});

describe('avaliação parcial do lead', () => {
  const row = (over: Partial<LeadRow> = {}): LeadRow => ({
    id: 1,
    source: 'indeed',
    title: 'Estágio em Help Desk',
    company: 'Avita',
    location: 'Brasil',
    work_mode: 'remoto',
    stipend_text: 'R$ 1.800 por mês',
    url: null,
    received_on: null,
    channel: 'desconhecido',
    status: 'nova',
    note: null,
    created_at: 'a',
    ...over,
  });

  it('nunca resulta em "apto", mesmo com título, local e bolsa perfeitos', () => {
    const a = assessLead(profile(), row());
    expect(a).toMatchObject({
      area: 'atende',
      location: 'atende',
      stipend: 'atende',
      verdict: 'revisao_humana',
    });
    expect(a.reasons.join(' ')).toContain('e-mail nunca é presumido');
  });

  it('título fora de TI, local incompatível ou bolsa abaixo do mínimo tornam o lead inapto', () => {
    expect(assessLead(profile(), row({ title: 'Estágio em Marketing' })).verdict).toBe('inapto');
    expect(
      assessLead(profile(), row({ work_mode: 'presencial', location: 'Campinas, SP' })).verdict,
    ).toBe('inapto');
    expect(assessLead(profile(), row({ stipend_text: 'R$ 800 por mês' })).verdict).toBe('inapto');
  });

  it('dados ausentes ficam "a confirmar", sem inventar', () => {
    const a = assessLead(profile(), row({ work_mode: null, location: null, stipend_text: null }));
    expect(a).toMatchObject({
      location: 'indeterminado',
      stipend: 'indeterminado',
      verdict: 'revisao_humana',
    });
  });

  it('presencial em São Paulo sem tempo confirmado: deslocamento pendente', () => {
    const a = assessLead(
      profile({ commute: [] }),
      row({ work_mode: 'presencial', location: 'São Paulo, SP' }),
    );
    expect(a.location).toBe('indeterminado');
  });
});

describe('comandos e isolamento', () => {
  it('registra add, import, list e set, sem nenhuma opção de e-mail ou envio', () => {
    const program = new Command();
    registerLeadCommands(program, {
      withDb: () => {
        throw new Error('não deveria executar');
      },
      parseId: Number,
    });
    const names = program.commands.find((c) => c.name() === 'leads')?.commands.map((c) => c.name());
    expect(names).toEqual(['add', 'import', 'list', 'set']);
    const options = program.commands
      .find((c) => c.name() === 'leads')
      ?.commands.flatMap((c) => c.options.map((o) => o.long ?? ''));
    expect(options?.join(' ')).not.toMatch(/email|enviar|send|autoriz/iu);
  });

  it('os módulos de leads não importam o canal de e-mail nem tocam em candidaturas', () => {
    for (const file of ['src/discovery/leads.ts', 'src/cli/leads.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\.\.\/email|gmail|sendEmail|applications|EMAIL_SEND/u);
    }
  });
});
