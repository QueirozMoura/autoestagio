import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApplicationError,
  STATUSES,
  TRANSITIONS,
  countByStatus,
  createApplication,
  getApplication,
  getHistory,
  listApplications,
  recoverInterrupted,
  setApplicationMode,
  transitionApplication,
  type Status,
} from '../../src/applications/index.js';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { CV, PROFILE_HASH, T0, minutesAfter, seedJob } from '../helpers/applications.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

const create = (jobId: number, extra = {}) =>
  createApplication(db, { jobId, cv: CV, profileHash: PROFILE_HASH, ...extra }, T0);

function make(extra = {}): number {
  const result = create(seedJob(db), extra);
  if (!result.created) throw new Error(`falha ao criar: ${JSON.stringify(result)}`);
  return result.application.id;
}

const go = (id: number, to: Status, extra: Record<string, unknown> = {}, at = T0) =>
  transitionApplication(db, id, { to, reason: `teste ${to}`, ...extra }, at);

/** Leva uma candidatura nova até "aprovada para envio" (modo revisão, canal e-mail). */
function approved(): number {
  const id = make({ channel: 'email' });
  setApplicationMode(db, id, 'revisao', { reason: 'revisão manual', actor: 'usuario' }, T0);
  go(id, 'aprovada_para_envio', { actor: 'usuario' });
  return id;
}

describe('criação', () => {
  it('nasce em dry-run, preparada, com a versão exata do currículo e o histórico inicial', () => {
    const jobId = seedJob(db);
    const result = create(jobId, { channel: 'email' });
    expect(result).toMatchObject({ created: true });
    if (!result.created) return;
    expect(result.application).toMatchObject({
      jobId,
      mode: 'dry-run',
      status: 'preparada',
      channel: 'email',
      cvSha256: CV.sha256,
      cvLabel: CV.label,
      eligibilityVerdict: 'apto',
      profileHash: PROFILE_HASH,
    });
    expect(getHistory(db, result.application.id)).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: 'preparada',
        mode: 'dry-run',
        channel: 'email',
        actor: 'sistema',
        createdAt: T0.toISOString(),
        reason: 'candidatura criada em dry-run (nada é enviado)',
      }),
    ]);
  });

  it('é idempotente: repetir para a mesma vaga devolve a existente, sem duplicar', () => {
    const jobId = seedJob(db);
    const first = create(jobId);
    const second = create(jobId);
    expect(second).toMatchObject({ created: false, reason: 'ja_existe' });
    if (first.created && !second.created && second.reason === 'ja_existe') {
      expect(second.application.id).toBe(first.application.id);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM application_events').get()).toEqual({ n: 1 });
  });

  it.each([
    ['inapto', 'inapta'],
    [null, 'sem_analise'],
  ] as const)('vaga com análise %s é recusada (%s)', (verdict, reason) => {
    expect(create(seedJob(db, { verdict }))).toMatchObject({ created: false, reason });
  });

  it('análise feita com outro perfil é recusada', () => {
    expect(create(seedJob(db, { profileHash: 'outro' }))).toMatchObject({
      created: false,
      reason: 'analise_desatualizada',
    });
  });

  it('vaga inexistente é recusada', () => {
    expect(create(9999)).toMatchObject({ created: false, reason: 'vaga_inexistente' });
  });

  it('vaga em revisão humana só entra com decisão explícita e motivo', () => {
    const jobId = seedJob(db, { verdict: 'revisao_humana' });
    expect(create(jobId)).toMatchObject({ created: false, reason: 'revisao_sem_autorizacao' });
    expect(() => create(jobId, { reviewOverride: { reason: '  ' } })).toThrow(ApplicationError);

    const ok = create(jobId, { reviewOverride: { reason: 'bolsa confirmada com o recrutador' } });
    expect(ok).toMatchObject({ created: true });
    if (!ok.created) return;
    expect(ok.application.eligibilityVerdict).toBe('revisao_humana');
    expect(ok.application.eligibilityOverrideReason).toMatch(/bolsa confirmada/);
    expect(getHistory(db, ok.application.id)[0]).toMatchObject({ actor: 'usuario' });
  });
});

describe('vagas equivalentes (detecção conservadora)', () => {
  it('mesma URL canônica, de candidatura ou de outra aparição: bloqueio que ninguém libera', () => {
    const a = seedJob(db, {
      url: 'https://jobs.exemplo.com/x/1',
      applyUrl: 'https://jobs.exemplo.com/x/1/apply',
    });
    expect(create(a)).toMatchObject({ created: true });

    const sameApply = seedJob(db, { applyUrl: 'https://jobs.exemplo.com/x/1/apply' });
    const blocked = create(sameApply, { acknowledgeEquivalent: { reason: 'quero mesmo assim' } });
    expect(blocked).toMatchObject({ created: false, reason: 'vaga_equivalente' });
    if (!blocked.created && blocked.reason === 'vaga_equivalente') {
      expect(blocked.equivalents[0]).toMatchObject({ kind: 'mesma_url' });
    }

    // Aparição extra de outra fonte com a mesma URL canônica da vaga já candidatada.
    const viaSighting = seedJob(db);
    db.prepare(
      `INSERT INTO job_sightings (job_id, source_id, external_id, url, canonical_url, first_seen_at, last_seen_at)
       VALUES (?, 1, NULL, 'https://jobs.exemplo.com/x/1', 'https://jobs.exemplo.com/x/1', 'x', 'x')`,
    ).run(viaSighting);
    expect(create(viaSighting)).toMatchObject({ created: false, reason: 'vaga_equivalente' });
  });

  it('mesmo identificador na mesma fonte nem chega a ser outra vaga: o banco impede (índice único)', () => {
    seedJob(db, { externalId: 'abc-1' });
    expect(() => seedJob(db, { externalId: 'abc-1' })).toThrow(/UNIQUE/);
  });

  it('mesma identidade (empresa+título+local) bloqueia, mas uma pessoa pode reconhecer que é outra vaga', () => {
    expect(create(seedJob(db, { identityKey: 'id-1', company: 'Acme' }))).toMatchObject({
      created: true,
    });
    const twin = seedJob(db, { identityKey: 'id-1', company: 'Acme' });

    expect(create(twin)).toMatchObject({ created: false, reason: 'vaga_equivalente' });
    const ok = create(twin, { acknowledgeEquivalent: { reason: 'cidade diferente, confirmado' } });
    expect(ok).toMatchObject({ created: true });
    if (ok.created) {
      expect(getHistory(db, ok.application.id)[0]?.reason).toMatch(/outra: cidade diferente/);
      expect(ok.warnings).toHaveLength(1); // mesma empresa: só aviso
    }
  });

  it('par marcado como possível duplicata pela coleta bloqueia (liberável)', () => {
    const a = seedJob(db);
    const b = seedJob(db);
    db.prepare(
      "INSERT INTO job_possible_duplicates (job_id, other_job_id, reason, created_at) VALUES (?, ?, 'x', 'x')",
    ).run(b, a);
    create(a);
    expect(create(b)).toMatchObject({ created: false, reason: 'vaga_equivalente' });
    expect(create(b, { acknowledgeEquivalent: { reason: 'são vagas distintas' } })).toMatchObject({
      created: true,
    });
  });

  it('mesma empresa em outra vaga é só aviso, não bloqueio', () => {
    create(seedJob(db, { company: 'Acme' }));
    const result = create(seedJob(db, { company: 'ACME ' }));
    expect(result).toMatchObject({ created: true });
    if (result.created) expect(result.warnings).toHaveLength(1);
  });

  it('candidatura equivalente que falhou sem nunca ter saído não bloqueia', () => {
    const first = make();
    // vaga gêmea
    const a = db.prepare('SELECT job_id FROM applications WHERE id = ?').get(first) as {
      job_id: number;
    };
    db.prepare("UPDATE jobs SET identity_key = 'gemea' WHERE id = ?").run(a.job_id);
    const twin = seedJob(db, { identityKey: 'gemea' });
    expect(create(twin)).toMatchObject({ created: false, reason: 'vaga_equivalente' });

    go(first, 'falhou');
    expect(create(twin)).toMatchObject({ created: true });
  });
});

describe('máquina de estados', () => {
  const allowed = STATUSES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as const));
  const forbidden = STATUSES.flatMap((from) =>
    STATUSES.filter((to) => !TRANSITIONS[from].includes(to)).map((to) => [from, to] as const),
  );

  it('a tabela de transições cobre todos os estados e não tem destino desconhecido', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATUSES].sort());
    for (const [, to] of allowed) expect(STATUSES).toContain(to);
  });

  it.each(forbidden)('%s → %s é recusada', (from, to) => {
    const id = make();
    db.prepare("UPDATE applications SET status = ?, mode = 'revisao' WHERE id = ?").run(from, id); // pula direto, só para o teste
    expect(() => go(id, to)).toThrow(/não se pode ir para/);
  });

  it('o caminho completo registra cada passo com data, canal, ator e motivo', () => {
    const id = approved();
    go(id, 'enviando', {}, minutesAfter(1));
    go(id, 'enviada', {}, minutesAfter(2));
    const done = go(
      id,
      'entrega_confirmada',
      { confirmation: 'protocolo ficticio 123' },
      minutesAfter(3),
    );
    expect(done.application).toMatchObject({
      status: 'entrega_confirmada',
      appliedAt: minutesAfter(2).toISOString(),
      hasConfirmation: true,
    });

    const history = getHistory(db, id);
    expect(history.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual([
      'null>preparada',
      'preparada>preparada', // mudança de modo (registrada)
      'preparada>aprovada_para_envio',
      'aprovada_para_envio>enviando',
      'enviando>enviada',
      'enviada>entrega_confirmada',
    ]);
    expect(history.at(-1)).toMatchObject({
      channel: 'email',
      mode: 'revisao',
      createdAt: minutesAfter(3).toISOString(),
      reason: 'teste entrega_confirmada',
    });
    expect(countByStatus(db).entrega_confirmada).toBe(1);
  });

  it('exige motivo em toda transição', () => {
    const id = make();
    expect(() => transitionApplication(db, id, { to: 'falhou', reason: ' ' }, T0)).toThrow(
      /motivo/,
    );
  });

  it('entrega confirmada exige evidência', () => {
    const id = approved();
    go(id, 'enviando');
    go(id, 'enviada');
    expect(() => go(id, 'entrega_confirmada')).toThrow(/evidência/);
  });

  it('candidatura inexistente', () => {
    expect(() => go(404, 'falhou')).toThrow(/não existe/);
    expect(getApplication(db, 404)).toBeUndefined();
  });

  it('canal desconhecido é recusado', () => {
    const id = make();
    expect(() => go(id, 'falhou', { channel: 'pombo' })).toThrow(/canal desconhecido/);
  });
});

describe('dry-run é o padrão e nada é enviado nele', () => {
  it('em dry-run não aprova nem envia, nem por SQL direto (trigger)', () => {
    const id = make({ channel: 'email' });
    expect(() => go(id, 'aprovada_para_envio')).toThrow(/dry-run/);
    expect(() =>
      db.prepare("UPDATE applications SET status = 'enviada' WHERE id = ?").run(id),
    ).toThrow(/dry-run/);
    expect(getApplication(db, id)?.status).toBe('preparada');
  });

  it('auto só com autorização explícita do usuário', () => {
    const id = make();
    const base = { reason: 'ativação', actor: 'usuario' as const };
    expect(() => setApplicationMode(db, id, 'auto', base, T0)).toThrow(/autorização explícita/);
    expect(() =>
      setApplicationMode(db, id, 'auto', { ...base, actor: 'sistema', authorizeAuto: true }, T0),
    ).toThrow(/só uma pessoa/);
    expect(setApplicationMode(db, id, 'auto', { ...base, authorizeAuto: true }, T0).mode).toBe(
      'auto',
    );
  });

  it('voltar a dry-run cancela a aprovação de envio e fica no histórico', () => {
    const id = approved();
    const back = setApplicationMode(
      db,
      id,
      'dry-run',
      { reason: 'cancelei', actor: 'usuario' },
      T0,
    );
    expect(back).toMatchObject({ mode: 'dry-run', status: 'preparada' });
    expect(getHistory(db, id).at(-1)).toMatchObject({
      toStatus: 'preparada',
      reason: 'modo revisao → dry-run: cancelei',
    });
  });

  it('o modo não muda depois que o envio começou', () => {
    const id = approved();
    go(id, 'enviando');
    expect(() =>
      setApplicationMode(db, id, 'dry-run', { reason: 'x', actor: 'usuario' }, T0),
    ).toThrow(/não muda/);
  });

  it('enviar exige canal definido', () => {
    const id = make(); // sem canal
    setApplicationMode(db, id, 'revisao', { reason: 'r', actor: 'usuario' }, T0);
    go(id, 'aprovada_para_envio', { actor: 'usuario' });
    expect(() => go(id, 'enviando')).toThrow(/canal/);
    expect(go(id, 'enviando', { channel: 'portal' }).application.channel).toBe('portal');
  });

  it('não envia se uma candidatura equivalente já saiu', () => {
    const first = approved();
    const a = db.prepare('SELECT job_id FROM applications WHERE id = ?').get(first) as {
      job_id: number;
    };
    db.prepare("UPDATE jobs SET identity_key = 'gemea' WHERE id = ?").run(a.job_id);
    const twinJob = seedJob(db, { identityKey: 'gemea' });
    const twin = createApplication(
      db,
      {
        jobId: twinJob,
        cv: CV,
        profileHash: PROFILE_HASH,
        channel: 'email',
        acknowledgeEquivalent: { reason: 'teste' },
      },
      T0,
    );
    if (!twin.created) throw new Error('esperava criar');
    setApplicationMode(db, twin.application.id, 'revisao', { reason: 'r', actor: 'usuario' }, T0);
    go(twin.application.id, 'aprovada_para_envio', { actor: 'usuario' });

    go(first, 'enviando');
    expect(() => go(twin.application.id, 'enviando')).toThrow(/equivalente já enviada/);
  });
});

describe('falhas, retentativas e intervenção humana', () => {
  it('falhou sem nunca ter saído pode ser refeita; depois de enviada, não', () => {
    const id = make();
    go(id, 'falhou');
    expect(go(id, 'preparada').application.status).toBe('preparada');

    const sent = approved();
    go(sent, 'enviando');
    go(sent, 'enviada');
    go(sent, 'pendente_intervencao_humana');
    expect(() => go(sent, 'preparada', { actor: 'usuario' })).toThrow(/já foi enviada/);
  });

  it('depois de uma tentativa de envio, só uma pessoa refaz o preparo', () => {
    const id = approved();
    go(id, 'enviando');
    go(id, 'falhou');
    expect(() => go(id, 'preparada')).toThrow(/só uma pessoa/);
    expect(go(id, 'preparada', { actor: 'usuario' }).changed).toBe(true);
  });

  it('só uma pessoa resolve uma pendência de intervenção humana', () => {
    const id = approved();
    go(id, 'enviando');
    go(id, 'pendente_intervencao_humana');
    expect(() => go(id, 'enviada')).toThrow(/só uma pessoa/);
    expect(go(id, 'enviada', { actor: 'usuario' }).application.status).toBe('enviada');
  });
});

describe('idempotência de transições', () => {
  it('a mesma chave repetida não muda nada nem duplica o histórico', () => {
    const id = approved();
    const first = go(id, 'enviando', { idempotencyKey: 'envio-1' });
    const again = go(id, 'enviando', { idempotencyKey: 'envio-1' }, minutesAfter(5));
    expect(first.changed).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.application.status).toBe('enviando');
    expect(again.application.updatedAt).toBe(first.application.updatedAt);
    expect(getHistory(db, id).filter((e) => e.toStatus === 'enviando')).toHaveLength(1);
  });

  it('sem chave, repetir uma transição já feita é erro (não silencioso)', () => {
    const id = approved();
    go(id, 'enviando');
    expect(() => go(id, 'enviando')).toThrow(/não se pode ir para/);
  });
});

describe('recuperação após falhas', () => {
  it('envio interrompido vai para intervenção humana e nunca é reenviado sozinho', () => {
    const id = approved();
    go(id, 'enviando', {}, T0); // o processo "cai" aqui

    expect(recoverInterrupted(db, { olderThanMs: 15 * 60_000, now: minutesAfter(5) })).toEqual([]);
    expect(getApplication(db, id)?.status).toBe('enviando');

    expect(recoverInterrupted(db, { olderThanMs: 15 * 60_000, now: minutesAfter(20) })).toEqual([
      id,
    ]);
    expect(getApplication(db, id)?.status).toBe('pendente_intervencao_humana');
    expect(getHistory(db, id).at(-1)).toMatchObject({
      actor: 'sistema',
      reason: 'envio interrompido antes de registrar o resultado; verifique se foi enviado',
    });

    // Idempotente e sem efeito colateral: nada volta a "enviando".
    expect(recoverInterrupted(db, { olderThanMs: 15 * 60_000, now: minutesAfter(30) })).toEqual([]);
    expect(() => go(id, 'enviando')).toThrow();
  });

  it('o banco sobrevive à reabertura: o estado e o histórico persistem', () => {
    const id = approved();
    go(id, 'enviando');
    expect(getHistory(db, id).length).toBeGreaterThan(3);
    expect(listApplications(db, { status: 'enviando' })).toHaveLength(1);
  });

  it('uma transição que falha no meio não deixa estado pela metade', () => {
    const id = approved();
    // Força falha no INSERT do evento: chave de idempotência já usada em outra operação.
    go(id, 'enviando', { idempotencyKey: 'k' });
    db.exec('DROP INDEX idx_application_events_idempotency');
    db.exec(
      "CREATE TRIGGER falha_ao_registrar BEFORE INSERT ON application_events WHEN NEW.to_status = 'enviada' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END",
    );
    expect(() => go(id, 'enviada')).toThrow(/falha simulada/);
    expect(getApplication(db, id)?.status).toBe('enviando'); // revertido
    expect(getApplication(db, id)?.appliedAt).toBeNull();
  });
});

describe('histórico imutável e integridade no banco', () => {
  it('eventos não podem ser alterados nem apagados', () => {
    const id = make();
    expect(() =>
      db.prepare('UPDATE application_events SET reason = ? WHERE application_id = ?').run('x', id),
    ).toThrow(/imutável/);
    expect(() =>
      db.prepare('DELETE FROM application_events WHERE application_id = ?').run(id),
    ).toThrow(/imutável/);
  });

  it('a vaga e o currículo de uma candidatura não mudam depois de criada', () => {
    const id = make();
    expect(() =>
      db.prepare('UPDATE applications SET cv_sha256 = ? WHERE id = ?').run('d'.repeat(64), id),
    ).toThrow(/imutáveis/);
    expect(() =>
      db.prepare('UPDATE applications SET job_id = job_id + 1 WHERE id = ?').run(id),
    ).toThrow(/imutáveis/);
  });

  it('o banco impede duas candidaturas para a mesma vaga', () => {
    const jobId = seedJob(db);
    create(jobId);
    expect(() =>
      db
        .prepare(
          `INSERT INTO applications (job_id, cv_sha256, cv_label, eligibility_verdict, profile_hash, created_at, updated_at)
           VALUES (?, ?, 'x', 'apto', 'h', 'x', 'x')`,
        )
        .run(jobId, 'e'.repeat(64)),
    ).toThrow(/UNIQUE/);
  });

  it('vaga inapta não pode virar candidatura nem por SQL', () => {
    const jobId = seedJob(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO applications (job_id, cv_sha256, cv_label, eligibility_verdict, profile_hash, created_at, updated_at)
           VALUES (?, ?, 'x', 'inapto', 'h', 'x', 'x')`,
        )
        .run(jobId, 'e'.repeat(64)),
    ).toThrow(/CHECK/);
  });
});
