import { beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import {
  RecipientError,
  extractEmails,
  isFreemail,
  listRecipients,
  maskEmail,
  usableRecipient,
  verifyRecipientFromJob,
  verifyRecipientFromPage,
} from '../../src/email/index.js';
import { seedJob } from '../helpers/applications.js';
import { setup } from '../helpers/adapters.js';
import { textResponse } from '../helpers/mock-fetch.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  runMigrations(db);
});

describe('extractEmails — só o que está escrito, nada deduzido', () => {
  it('acha endereços literais e mailto:, em minúsculas e sem repetição', () => {
    expect(
      extractEmails(
        'Fale com RH@Acme.com.br ou <a href="mailto:vagas@acme.com.br">aqui</a>. Repetido: rh@acme.com.br.',
      ),
    ).toEqual(['rh@acme.com.br', 'vagas@acme.com.br']);
  });

  it('não reconstrói endereços disfarçados nem monta endereços a partir de nomes', () => {
    expect(
      extractEmails('rh [arroba] acme.com.br; rh (at) acme.com.br; contato: Maria Silva da Acme'),
    ).toEqual([]);
    expect(extractEmails('Site: https://www.acme.com.br/carreiras')).toEqual([]);
  });

  it('descarta pontuação final e endereços inválidos', () => {
    expect(extractEmails('Escreva para rh@acme.com.br.')).toEqual(['rh@acme.com.br']);
    expect(extractEmails('a..b@acme.com e x@y')).toEqual([]);
  });

  it('classifica provedores gratuitos e mascara endereços', () => {
    expect(isFreemail('alguem@gmail.com')).toBe(true);
    expect(isFreemail('rh@acme.com.br')).toBe(false);
    expect(maskEmail('rh@acme.com.br')).toBe('r***@acme.com.br');
  });
});

describe('verifyRecipientFromJob', () => {
  const job = (description: string | null) =>
    seedJob(db, { description, url: 'https://jobs.exemplo.com/acme/1' });

  it('aceita o endereço escrito na vaga oficial e registra a fonte e a evidência (hash)', () => {
    const id = job('Envie para rh@acme.com.br.');
    const recipient = verifyRecipientFromJob(db, id, ' RH@Acme.com.br ');
    expect(recipient).toMatchObject({
      email: 'rh@acme.com.br',
      sourceKind: 'vaga_oficial',
      sourceUrl: 'https://jobs.exemplo.com/acme/1',
      freemail: false,
    });
    expect(db.prepare('SELECT length(evidence_hash) AS n FROM verified_recipients').get()).toEqual({
      n: 64,
    });
    expect(usableRecipient(db, id)?.email).toBe('rh@acme.com.br');
  });

  it('é idempotente (mesmo endereço, mesma vaga)', () => {
    const id = job('rh@acme.com.br');
    verifyRecipientFromJob(db, id, 'rh@acme.com.br');
    verifyRecipientFromJob(db, id, 'rh@acme.com.br');
    expect(listRecipients(db, id)).toHaveLength(1);
  });

  it('recusa endereço que NÃO está na vaga (nada é adivinhado)', () => {
    const id = job('Envie para rh@acme.com.br.');
    for (const guess of ['vagas@acme.com.br', 'rh@acme.com', 'recrutamento@acme.com.br']) {
      expect(() => verifyRecipientFromJob(db, id, guess)).toThrow(/não aparece na descrição/);
    }
    expect(() => verifyRecipientFromJob(db, job(null), 'rh@acme.com.br')).toThrow(RecipientError);
    expect(listRecipients(db, id)).toEqual([]);
    expect(usableRecipient(db, id)).toBeUndefined();
  });

  it('endereço inválido e vaga inexistente', () => {
    expect(() => verifyRecipientFromJob(db, job('x'), 'não é e-mail')).toThrow(/inválido/);
    expect(() => verifyRecipientFromJob(db, 999, 'rh@acme.com.br')).toThrow(/não existe/);
  });

  it('provedor gratuito exige confirmação explícita e só então é utilizável', () => {
    const id = job('Contato: vagas.acme@gmail.com');
    expect(() => verifyRecipientFromJob(db, id, 'vagas.acme@gmail.com')).toThrow(
      /provedor gratuito/,
    );
    expect(usableRecipient(db, id)).toBeUndefined();
    const confirmed = verifyRecipientFromJob(db, id, 'vagas.acme@gmail.com', {
      confirmFreemail: true,
    });
    expect(confirmed).toMatchObject({ freemail: true, freemailConfirmed: true });
    expect(usableRecipient(db, id)?.email).toBe('vagas.acme@gmail.com');
  });

  it('o banco recusa endereço com maiúsculas, espaços ou sem @', () => {
    const id = job('x');
    const insert = (email: string) =>
      db
        .prepare(
          `INSERT INTO verified_recipients (job_id, email, source_kind, source_url, evidence_hash, verified_at)
           VALUES (?, ?, 'vaga_oficial', 'u', ?, 'x')`,
        )
        .run(id, email, 'a'.repeat(64));
    expect(() => insert('RH@acme.com')).toThrow(/CHECK/);
    expect(() => insert('a b@acme.com')).toThrow(/CHECK/);
    expect(() => insert('semarroba')).toThrow(/CHECK/);
  });
});

describe('verifyRecipientFromPage (página oficial da empresa)', () => {
  const PAGE = 'https://www.acme-ficticia.com.br/carreiras';
  const ROBOTS = 'https://www.acme-ficticia.com.br/robots.txt';
  const html =
    '<html><body><p>Vagas: <a href="mailto:talentos@acme-ficticia.com.br">escreva</a></p></body></html>';
  const run = (overrides: Record<string, unknown> = {}, body = html) => {
    const jobId = seedJob(db);
    const { client, calls } = setup({
      [ROBOTS]: () => textResponse('User-agent: *\nAllow: /'),
      [PAGE]: () => textResponse(body),
    });
    return {
      calls,
      promise: verifyRecipientFromPage(db, client, {
        jobId,
        email: 'talentos@acme-ficticia.com.br',
        pageUrl: PAGE,
        companyDomain: 'acme-ficticia.com.br',
        ...overrides,
      }),
      jobId,
    };
  };

  it('aceita endereço visível na página HTTPS do domínio da empresa', async () => {
    const { promise, jobId, calls } = run();
    const recipient = await promise;
    expect(recipient).toMatchObject({
      sourceKind: 'pagina_oficial_empresa',
      companyDomain: 'acme-ficticia.com.br',
      sourceUrl: PAGE,
    });
    expect(usableRecipient(db, jobId)?.email).toBe('talentos@acme-ficticia.com.br');
    expect(calls.filter((c) => c.url === PAGE).every((c) => c.init?.method === 'GET')).toBe(true);
  });

  it('recusa quando o endereço não aparece na página', async () => {
    await expect(run({}, '<p>Sem contato</p>').promise).rejects.toThrow(/não aparece na página/);
  });

  it('recusa página que não é do domínio informado, HTTP simples e endereço de outro domínio', async () => {
    await expect(run({ pageUrl: 'https://outra-empresa.com/vagas' }).promise).rejects.toThrow(
      /precisa ser HTTPS e do domínio/,
    );
    await expect(
      run({ pageUrl: 'http://www.acme-ficticia.com.br/carreiras' }).promise,
    ).rejects.toThrow(/HTTPS/);
    await expect(run({ email: 'talentos@outra.com' }).promise).rejects.toThrow(/não é do domínio/);
  });

  it.each(['gmail.com', 'linkedin.com', 'jobs.ashbyhq.com', 'github.io', 'semponto', 'com.br'])(
    'domínio "%s" não vale como domínio próprio da empresa',
    async (companyDomain) => {
      await expect(run({ companyDomain }).promise).rejects.toThrow(RecipientError);
    },
  );
});
