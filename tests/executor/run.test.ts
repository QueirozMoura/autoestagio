import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildQueue, listQueue, parsePolicy, runAutonomous } from '../../src/autonomy/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { runExecutor, type ExecOptions } from '../../src/executor/index.js';
import { seedJob, type SeedJob } from '../helpers/applications.js';
import { profile } from '../helpers/eligibility.js';
import { FakeSession, type FakePage } from './fake-driver.js';
import { applicant, field, form, greenhouseLike, signals } from './fixtures.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const policy = parsePolicy({ rules: { tolerateUnknown: ['bolsa', 'modalidade'] } });
const dirs: string[] = [];
let db: Db;
let out: string;
let cvDir: string;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
  out = mkdtempSync(join(tmpdir(), 'exec-'));
  cvDir = mkdtempSync(join(tmpdir(), 'cv-'));
  dirs.push(out, cvDir);
  writeFileSync(join(cvDir, 'curriculo-generico-20261023-aaaa1111.pdf'), '%PDF-1.4\n% ficticio\n');
  writeFileSync(
    join(cvDir, 'curriculo-desenvolvimento-20261023-bbbb2222.pdf'),
    '%PDF-1.4\n% dev ficticio\n',
  );
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const url = (n: number): string => `https://empresa${n}.inhire.app/vagas/${n}`;
const vaga = (n: number, over: SeedJob = {}): number =>
  seedJob(db, {
    verdict: null,
    title: 'Estágio em Desenvolvimento de Software',
    company: `Empresa ${n}`,
    workMode: 'remoto',
    location: 'Brasil',
    stipend: 1800,
    applyUrl: url(n),
    ...over,
  });

const prepare = async (): Promise<void> => {
  await runAutonomous({ db, profile: profile(), policy, mode: 'simulacao', now: () => NOW });
  buildQueue(db, profile(), policy, NOW);
};

const exec = (session: FakeSession, over: Partial<ExecOptions> = {}) =>
  runExecutor({
    db,
    profile: profile(),
    applicant,
    salary: 1800,
    session,
    mode: 'preparar',
    max: 5,
    outputDir: out,
    cvDir,
    now: () => NOW,
    ...over,
  });

const okPage = (over: Partial<FakePage> = {}): FakePage => ({
  signals: signals(),
  form: greenhouseLike(),
  ...over,
});
const statusOf = (jobId: number): string =>
  (
    db.prepare('SELECT q.status AS s FROM autonomous_queue q WHERE q.job_id = ?').get(jobId) as {
      s: string;
    }
  ).s;

describe('executor assistido', () => {
  it('retoma pendente_humano apenas por --item e planejar preserva esse estado', async () => {
    const id = vaga(1);
    await prepare();
    const queueId = listQueue(db).find((item) => item.jobId === id)?.id ?? 0;
    await exec(new FakeSession({ [url(1)]: okPage() }));
    expect(statusOf(id)).toBe('pendente_humano');
    expect((await exec(new FakeSession({}))).items).toEqual([]);
    const planned = await exec(new FakeSession({ [url(1)]: okPage() }), {
      itemId: queueId,
      mode: 'planejar',
    });
    expect(planned.items).toHaveLength(1);
    expect(statusOf(id)).toBe('pendente_humano');
    const resumed = await exec(new FakeSession({ [url(1)]: okPage() }), { itemId: queueId });
    expect(resumed.items[0]?.outcome).toBe('pronto_para_revisao');
    expect(statusOf(id)).toBe('pendente_humano');
    db.prepare("UPDATE autonomous_queue SET status = 'em_andamento' WHERE id = ?").run(queueId);
    expect((await exec(new FakeSession({}), { itemId: queueId })).items).toEqual([]);
  });

  it('não anuncia pronto com botão desabilitado ou opção diferente de mesmo prefixo', async () => {
    vaga(1);
    vaga(2);
    await prepare();
    const run = await exec(
      new FakeSession({
        [url(1)]: okPage({ signals: signals({ submitEnabled: false }) }),
        [url(2)]: okPage({ selectReadBack: 'Brasil - outra opção' }),
      }),
    );
    expect(run.items.map((item) => item.outcome)).toEqual([
      'campos_desconhecidos',
      'campos_desconhecidos',
    ]);
    expect(run.items[1]?.filled.find((item) => item.label === 'País')?.ok).toBe(false);
  });

  it('bloqueia plataforma restrita antes de criar página, preservando os demais itens', async () => {
    const blocked = vaga(1, { applyUrl: 'https://www.linkedin.com/jobs/view/123' });
    vaga(2);
    await prepare();
    const session = new FakeSession({ [url(2)]: okPage() });
    const run = await exec(session);
    expect(run.items.find((item) => item.jobId === blocked)?.outcome).toBe('erro');
    expect(session.calls.some((call) => call.includes('linkedin.com/jobs'))).toBe(false);
    expect(run.items.find((item) => item.jobId !== blocked)?.outcome).toBe('pronto_para_revisao');
  });

  it('lê a próxima vaga da fila, abre o link, preenche, anexa o currículo e PARA antes do envio', async () => {
    const id = vaga(1);
    await prepare();
    const session = new FakeSession({ [url(1)]: okPage() });
    const run = await exec(session);
    const item = run.items[0];
    expect(item?.outcome).toBe('pronto_para_revisao');
    expect(item?.steps.map((s) => s.step)).toEqual([
      'selecionar_item',
      'abrir_link',
      'classificar_pagina',
      'identificar_campos',
      'selecionar_curriculo',
      'planejar_preenchimento',
      'preencher',
      'anexar_curriculo',
      'verificacao_final',
      'captura_de_tela',
      'parar_antes_do_envio',
    ]);
    expect(item?.steps.every((s) => s.state === 'ok')).toBe(true);
    expect(item?.filled.every((f) => f.ok)).toBe(true);
    expect(item?.cv).toMatchObject({ label: 'curriculo-desenvolvimento-20261023-bbbb2222.pdf' });
    // Só abre, lê, preenche, seleciona, anexa e fotografa: nada de envio.
    expect(
      session.calls.filter((c) =>
        /^(goto|extractForm|fill|select|choose|upload|screenshot|close)/.test(c),
      ),
    ).toHaveLength(session.calls.length);
    expect(session.calls.some((c) => /submit|click|enviar/i.test(c))).toBe(false);
    // Preparar não conclui nada: fica com você, sem evidência não há "concluida".
    expect(statusOf(id)).toBe('pendente_humano');
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM autonomous_queue WHERE status = 'concluida'").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
  });

  it('telefone: se a máscara do campo recusa o formato internacional, tenta o mesmo número no formato nacional', async () => {
    vaga(1);
    await prepare();
    const session = new FakeSession({ [url(1)]: okPage({ nationalPhoneMask: true }) });
    const run = await exec(session);
    const phone = run.items[0]?.filled.find((f) => f.source === 'applicant.phone');
    expect(phone?.ok).toBe(true);
    const phoneSelector = [...session.values.entries()].find(
      ([, v]) => v === '(11) 99999-9999',
    )?.[0];
    expect(phoneSelector).toBeDefined();
    expect(session.calls.filter((c) => c === `fill ${phoneSelector}`)).toHaveLength(2);
    expect(run.items[0]?.steps.find((s) => s.step === 'preencher')?.state).toBe('ok');
  });

  it('relê o formulário depois de preencher: campos que aparecem dinamicamente também são tratados', async () => {
    vaga(1);
    await prepare();
    const first = greenhouseLike();
    const second = form([
      ...first.fields,
      field({
        label: 'Nome da Universidade (caso não encontre, selecionar "outra")',
        kind: 'combobox',
        required: true,
        options: ['Outra', 'USP'],
      }),
      field({ label: 'CPF', required: true }),
    ]);
    const session = new FakeSession({ [url(1)]: okPage({ form: [first, second] }) });
    const run = await exec(session);
    const item = run.items[0];
    expect(item?.steps.map((s) => s.step)).toContain('reler_formulario');
    expect(item?.filled.map((f) => f.label)).toContain(
      'Nome da Universidade (caso não encontre, selecionar "outra")',
    );
    expect(session.calls.some((c) => c.startsWith('choose'))).toBe(true);
    // O CPF novo é pendência (nunca digitado) e o resultado deixa de ser "pronto".
    expect(item?.needsHuman.map((h) => h.label)).toEqual(['CPF']);
    expect(item?.outcome).toBe('campos_desconhecidos');
  });

  it('aplica só as respostas confirmadas para ESTE item, confere o botão de envio e os erros, e não conclui nada', async () => {
    const a = vaga(1);
    const b = vaga(2);
    await prepare();
    const questions = form([
      ...greenhouseLike().fields,
      field({
        label: 'Você autoriza a empresa a utilizar seus dados pessoais?',
        kind: 'other',
        required: true,
      }),
    ]);
    const session = new FakeSession({
      [url(1)]: okPage({ form: questions, signals: signals({ submitEnabled: true, errors: [] }) }),
      [url(2)]: okPage({
        form: questions,
        signals: signals({ submitEnabled: false, errors: ['campo inválido: Email'] }),
      }),
    });
    const itemA = listQueue(db).find((q) => q.jobId === a)?.id ?? 0;
    const run = await exec(session, {
      max: 2,
      answersFor: (id) =>
        id === itemA
          ? [
              {
                question: 'autoriza a empresa a utilizar seus dados',
                answer: 'Yes',
                source: 'resposta confirmada por você',
              },
            ]
          : [],
    });
    const first = run.items[0];
    const second = run.items[1];
    expect(first?.outcome).toBe('pronto_para_revisao');
    expect(first?.final).toEqual({
      submitLabel: 'Enviar candidatura',
      submitEnabled: true,
      errors: [],
    });
    expect(first?.filled.map((f) => f.label)).toContain(
      'Você autoriza a empresa a utilizar seus dados pessoais?',
    );
    // A resposta não vale para outra vaga: no segundo item continua pendente; erros de validação aparecem.
    expect(second?.needsHuman.map((h) => h.label)).toContain(
      'Você autoriza a empresa a utilizar seus dados pessoais?',
    );
    expect(second?.final).toMatchObject({
      submitEnabled: false,
      errors: ['campo inválido: Email'],
    });
    expect(second?.steps.find((s) => s.step === 'verificacao_final')?.state).toBe('falhou');
    expect(statusOf(a)).toBe('pendente_humano');
    expect(statusOf(b)).toBe('pendente_humano');
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM autonomous_queue WHERE status = 'concluida'").get(),
    ).toEqual({ n: 0 });
  });

  it('no modo manter-aberto grava o registro ANTES de esperar você e depois não conclui nada', async () => {
    const id = vaga(1);
    await prepare();
    const seen: string[] = [];
    const session = new FakeSession({
      [url(1)]: okPage({ afterText: 'Inscrição feita com sucesso!' }),
    });
    const run = await exec(session, {
      holdOnly: true,
      review: async () => {
        // Durante a espera a execução já está registrada e a vaga continua com você.
        seen.push(
          (
            db.prepare('SELECT COUNT(*) AS n FROM autonomous_executions').get() as { n: number }
          ).n.toString(),
        );
        seen.push(statusOf(id));
        await Promise.resolve();
      },
    });
    expect(seen).toEqual(['1', 'pendente_humano']);
    expect(run.items[0]?.outcome).toBe('pronto_para_revisao');
    expect(statusOf(id)).toBe('pendente_humano');
    expect(session.calls.at(-1)).toBe('close');
  });

  it('registra cada execução com etapas e campos, sem e-mail ou telefone completos', async () => {
    vaga(1);
    await prepare();
    await exec(new FakeSession({ [url(1)]: okPage() }));
    const row = db
      .prepare('SELECT outcome, steps, fields, cv_sha256 AS sha FROM autonomous_executions')
      .get() as {
      outcome: string;
      steps: string;
      fields: string;
      sha: string;
    };
    expect(row.outcome).toBe('pronto_para_revisao');
    expect(row.sha).toHaveLength(64);
    expect(row.fields).not.toContain('pessoa.exemplo@example.com');
    expect(row.fields).not.toContain('99999-9999');
    expect(row.fields).toContain('pe…@example.com');
    expect(JSON.parse(row.steps)).toHaveLength(11);
  });

  it('uma vaga bloqueada não impede as demais: login, CAPTCHA e campo desconhecido ficam com você e a execução segue', async () => {
    const a = vaga(1);
    const b = vaga(2);
    const c = vaga(3);
    const d = vaga(4);
    await prepare();
    const session = new FakeSession({
      [url(1)]: okPage({
        signals: signals({
          hasPasswordInput: true,
          fieldCount: 2,
          text: 'Entrar com sua conta Senha',
        }),
        form: form([]),
      }),
      [url(2)]: okPage({ signals: signals({ visibleCaptchaChallenge: true }) }),
      [url(3)]: okPage({
        form: form([
          field({ label: 'Email', kind: 'email', required: true }),
          field({ label: 'Qual seu nível de Kubernetes?', required: true }),
        ]),
      }),
      [url(4)]: okPage(),
    });
    const run = await exec(session, { max: 4 });
    expect(run.items.map((i) => i.outcome)).toEqual([
      'login',
      'captcha',
      'campos_desconhecidos',
      'pronto_para_revisao',
    ]);
    for (const id of [a, b, c, d]) expect(statusOf(id)).toBe('pendente_humano');
    const campos = run.items[2];
    expect(campos?.needsHuman.map((h) => h.label)).toEqual(['Qual seu nível de Kubernetes?']);
    expect(campos?.filled).toHaveLength(1);
  });

  it('vaga encerrada é cancelada com motivo; erro de navegação vira pendência e o próximo item é processado', async () => {
    const a = vaga(1);
    const b = vaga(2);
    const c = vaga(3);
    await prepare();
    const session = new FakeSession({
      [url(1)]: okPage({ signals: signals({ text: 'Inscrições encerradas!' }) }),
      [url(2)]: okPage({ failOn: 'goto' }),
      [url(3)]: okPage(),
    });
    const run = await exec(session, { max: 3 });
    expect(run.items.map((i) => i.outcome)).toEqual(['encerrada', 'erro', 'pronto_para_revisao']);
    expect(statusOf(a)).toBe('cancelada');
    expect(
      db.prepare('SELECT closed_reason AS r FROM autonomous_queue WHERE job_id = ?').get(a),
    ).toEqual({ r: 'vaga encerrada (a página informa)' });
    expect(statusOf(b)).toBe('pendente_humano');
    expect(statusOf(c)).toBe('pendente_humano');
  });

  it('o modo planejar só lê: nada é preenchido ou anexado e o item volta para "pronta"', async () => {
    const id = vaga(1);
    await prepare();
    const session = new FakeSession({ [url(1)]: okPage() });
    const run = await exec(session, { mode: 'planejar' });
    const item = run.items[0];
    expect(item?.outcome).toBe('pronto_para_revisao');
    expect(item?.filled).toEqual([]);
    expect(item?.planned.length).toBeGreaterThan(5);
    expect(item?.steps.find((s) => s.step === 'preencher')?.state).toBe('pulado');
    expect(session.calls.some((c) => /^(fill|select|upload)/.test(c))).toBe(false);
    expect(statusOf(id)).toBe('pronta');
  });

  it('só conclui com evidência da plataforma, vista depois que VOCÊ envia; sem confirmação nada é concluído', async () => {
    const a = vaga(1);
    const b = vaga(2);
    await prepare();
    const session = new FakeSession({
      [url(1)]: okPage({ afterText: 'Inscrição feita com sucesso! Você se inscreveu na vaga.' }),
      [url(2)]: okPage(),
    });
    const run = await exec(session, {
      max: 2,
      review: async (_item, page) => {
        (page as unknown as { __userSubmits(): void }).__userSubmits();
        await Promise.resolve();
      },
    });
    expect(run.items.map((i) => i.outcome)).toEqual([
      'concluida_com_evidencia',
      'pronto_para_revisao',
    ]);
    expect(statusOf(a)).toBe('concluida');
    expect(statusOf(b)).toBe('pendente_humano');
    const evidence = db
      .prepare('SELECT evidence FROM autonomous_queue WHERE job_id = ?')
      .get(a) as { evidence: string };
    expect(evidence.evidence).toContain('Inscrição feita com sucesso');
    // Depois de concluída, a vaga não volta nem é reprocessada.
    expect((await exec(new FakeSession({ [url(1)]: okPage() }), { max: 5 })).items).toEqual([]);
  });

  it('respeita --item e o limite, e dois executores não pegam o mesmo item', async () => {
    const a = vaga(1);
    vaga(2);
    await prepare();
    const first = listQueue(db).find((q) => q.jobId === a);
    const session = new FakeSession({ [url(1)]: okPage(), [url(2)]: okPage() });
    const only = await exec(session, { itemId: first?.id ?? 0, max: 5 });
    expect(only.items).toHaveLength(1);
    expect(only.remainingReady).toBe(1);
    const limited = await exec(session, { max: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.remainingReady).toBe(0);
    // Item em andamento (reservado por outro executor) não é pego.
    const c = vaga(3);
    await prepare();
    const qid = listQueue(db).find((q) => q.jobId === c)?.id ?? 0;
    db.prepare("UPDATE autonomous_queue SET status = 'em_andamento' WHERE id = ?").run(qid);
    expect((await exec(new FakeSession({ [url(3)]: okPage() }))).items).toEqual([]);
  });

  it('só abre links HTTPS e nunca o fluxo automático (e-mail)', async () => {
    const auto = vaga(1, {
      description: 'Envie seu currículo para rh@empresa1.com.br',
      applyUrl: url(1),
    });
    const inseguro = vaga(2, { applyUrl: 'http://inseguro.example/vaga' });
    await prepare();
    expect(statusOf(auto)).toBe('pronta');
    const session = new FakeSession({ [url(1)]: okPage() });
    const run = await exec(session, { max: 5 });
    expect(run.items.map((i) => i.jobId)).not.toContain(auto);
    const insecure = run.items.find((i) => i.jobId === inseguro);
    expect(insecure === undefined || insecure.outcome === 'erro').toBe(true);
  });
});
