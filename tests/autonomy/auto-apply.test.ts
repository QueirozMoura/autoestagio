import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Db } from '../../src/db/index.js';
import { analyzeJobs, profileHash } from '../../src/eligibility/index.js';
import { createGrant, grantCode, revokeGrant } from '../../src/autonomy/grant.js';
import { parsePolicy, type Policy } from '../../src/autonomy/policy.js';
import { runAutonomous } from '../../src/autonomy/run.js';
import {
  autoApplyManifestSchema,
  checkAutoApply,
  loadAutoApplyManifest,
  autoApplyStates,
  type AutoApplyManifest,
} from '../../src/autonomy/auto-apply.js';
import { GmailTransport } from '../../src/email/gmail.js';
import { type EmailContext } from '../../src/email/index.js';
import { findBrowser, PlaywrightPage, planForm } from '../../src/executor/index.js';
import { applicant } from '../executor/fixtures.js';
import { seedJob } from '../helpers/applications.js';
import {
  CV_BYTES,
  CV_SHA,
  FakeTransport,
  RECIPIENT,
  TEST_MAILBOX,
  emailProfile,
} from '../helpers/email.js';

const NOW = new Date('2026-10-24T12:00:00Z');
const hash = (text: Buffer | string) => createHash('sha256').update(text).digest('hex');
let db: Db;
let dir: string;
let file: string;
let jobId: number;
let manifest: AutoApplyManifest;
let policy: Policy;
let transport: FakeTransport;
let server: Server | undefined;
let clock: Date;
const profile = () => ({
  ...emailProfile(),
  approval: { cvFile: join(dir, 'cv.pdf'), cvSha256: CV_SHA, approvedAt: '2026-10-22' },
});
const load = () => loadAutoApplyManifest(file);
const entry = () => {
  const first = manifest.jobs[0];
  if (!first) throw new Error('entrada fictícia ausente');
  return first;
};
const save = () => {
  writeFileSync(file, JSON.stringify(manifest));
};
const check = () =>
  checkAutoApply({ db, profile: profile(), policy, jobId, load, now: clock, real: false });
const context = (): EmailContext => ({
  db,
  profile: profile(),
  transport,
  sendEnabled: true,
  maxPerDay: 5,
  testMailbox: TEST_MAILBOX,
  readCv: () => readFileSync(join(dir, 'cv.pdf')),
  now: () => clock,
});
const grant = () =>
  createGrant(db, policy, {
    days: 1,
    confirm: grantCode(policy, 1),
    reason: 'FICTÍCIO: teste isolado sem Gmail real',
    now: clock,
  });
const run = (over: Partial<Parameters<typeof runAutonomous>[0]> = {}) =>
  runAutonomous({
    db,
    profile: profile(),
    policy,
    mode: 'real',
    emailContext: context(),
    cv: { label: 'cv.pdf', sha256: CV_SHA },
    autoApply: { load, evidenceDir: join(dir, 'receipts') },
    now: () => clock,
    sleep: () => Promise.resolve(),
    ...over,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auto-apply-'));
  file = join(dir, 'manifest.json');
  db = openDatabase(':memory:');
  runMigrations(db);
  clock = new Date(NOW);
  transport = new FakeTransport();
  writeFileSync(join(dir, 'cv.pdf'), CV_BYTES);
  const proof =
    'AUTORIZAÇÃO FICTÍCIA: Acme autoriza expressamente candidaturas automatizadas para este e-mail nesta vaga.';
  writeFileSync(join(dir, 'permission.txt'), proof);
  jobId = seedJob(db, {
    verdict: null,
    title: 'Estágio em Desenvolvimento Backend',
    company: 'Acme Fictícia',
    description: `TypeScript e SQL. Envie sua candidatura para ${RECIPIENT}.`,
    workMode: 'remoto',
    location: 'Remote - Brazil',
    stipend: 1800,
  });
  // O helper antigo usa hashes legíveis; este fluxo exige o SHA-256 que a ingestão real grava.
  db.prepare('UPDATE jobs SET content_hash = ? WHERE id = ?').run(
    hash(`vaga fictícia ${jobId}`),
    jobId,
  );
  analyzeJobs({ db, profile: profile() });
  const job = db.prepare('SELECT content_hash FROM jobs WHERE id = ?').get(jobId) as {
    content_hash: string;
  };
  manifest = {
    version: 1,
    enabled: true,
    jobs: [
      {
        jobId,
        channel: 'email',
        jobContentHash: job.content_hash,
        profileHash: profileHash(profile()),
        cvSha256: CV_SHA,
        recipient: RECIPIENT,
        reviewedAt: '2026-10-24T11:00:00Z',
        validUntil: '2026-10-25T11:00:00Z',
        noAdditionalQuestionsOrConsents: true,
        permission: {
          kind: 'written_authorization',
          sourceUrl: 'https://acme-ficticia.com.br/autorizacao',
          issuerDomain: 'acme-ficticia.com.br',
          artifactPath: 'permission.txt',
          artifactSha256: hash(proof),
          explicitlyAllowsAutomation: true,
          reviewedAt: '2026-10-24T11:00:00Z',
        },
      },
    ],
  };
  save();
  policy = parsePolicy({
    enabled: true,
    limits: { maxPerRun: 2, maxPerDay: 5 },
    real: { authorized: true, connectors: ['email'], autoApplyManifestSha256: load().sha256 },
  });
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server?.close(() => {
        resolve();
      }),
    );
    server = undefined;
  }
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('AUTO_APPLY: política e evidência por vaga', () => {
  it('bloqueia manifesto ausente e permite apenas evidência íntegra com convite explícito', () => {
    expect(check().ok).toBe(true);
    expect(loadAutoApplyManifest(join(dir, 'missing.json')).manifest.enabled).toBe(false);
    writeFileSync(join(dir, 'permission.txt'), 'alterado');
    expect(check().reason).toMatch(/alterado/);
  });
  it('não aceita apenas a documentação do Gmail como autorização do empregador', () => {
    entry().permission.sourceUrl =
      'https://developers.google.com/workspace/gmail/api/guides/sending';
    save();
    expect(check().ok).toBe(false);
  });
  it('bloqueia consentimento/pergunta adicional, validade, revogação e conteúdo alterado', () => {
    entry().noAdditionalQuestionsOrConsents = false;
    save();
    expect(check().reason).toMatch(/perguntas|consentimentos/);
    entry().noAdditionalQuestionsOrConsents = true;
    entry().revokedAt = NOW.toISOString();
    save();
    expect(check().reason).toMatch(/revogada/);
    delete entry().revokedAt;
    entry().validUntil = '2026-10-24T11:00:00Z';
    save();
    expect(check().reason).toMatch(/vencida/);
    entry().validUntil = '2026-10-25T11:00:00Z';
    save();
    db.prepare('UPDATE jobs SET content_hash = ? WHERE id = ?').run('f'.repeat(64), jobId);
    expect(check().reason).toMatch(/alterada/);
  });
  it('não permite tolerância de requisito incerto no AUTO_APPLY', async () => {
    policy = parsePolicy({ ...policy, rules: { ...policy.rules, tolerateUnknown: ['bolsa'] } });
    db.prepare("UPDATE job_eligibility SET verdict = 'revisao_humana' WHERE job_id = ?").run(jobId);
    expect(check().reason).toMatch(/elegibilidade apta/);
    grant();
    const simulated = await run({ mode: 'simulacao' });
    expect(simulated.decisions.some((decision) => decision.decision === 'enviada')).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });
  it('rejeita duplicatas no manifesto e canal não implementado', () => {
    expect(() =>
      autoApplyManifestSchema.parse({ ...manifest, jobs: [manifest.jobs[0], manifest.jobs[0]] }),
    ).toThrow();
    expect(() =>
      autoApplyManifestSchema.parse({
        ...manifest,
        jobs: [{ ...manifest.jobs[0], channel: 'browser' }],
      }),
    ).toThrow();
  });
});

describe('AUTO_APPLY: envio autorizado com transporte falso', () => {
  it('simula sem conceder autorização, criar candidatura ou chamar transporte', async () => {
    const report = await run({ mode: 'simulacao' });
    expect(report.counts.candidatar).toBe(1);
    expect(report.autoApply?.checks[0]?.ok).toBe(true);
    expect(transport.calls).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM autonomous_grants').get()).toEqual({ n: 0 });
  });
  it('envia, salva comprovante do aceite e não confunde enviada com confirmada', async () => {
    grant();
    const report = await run();
    expect(report.counts.enviada).toBe(1);
    expect(autoApplyStates(db)[0]?.state).toBe('enviada');
    const receipt = JSON.parse(
      readFileSync(join(dir, 'receipts', `run-${report.runId}-job-${jobId}.json`), 'utf8'),
    ) as { confirmedByRecipient: boolean; receipt: { gmail_message_id: string } };
    expect(receipt.confirmedByRecipient).toBe(false);
    expect(receipt.receipt.gmail_message_id).toBe('fake-2');
    expect((await run()).decisions).toEqual([]);
    expect(transport.calls).toHaveLength(2);
  });
  it('revogação durante o teste prévio impede a candidatura real', async () => {
    const id = grant();
    transport.next(() => {
      revokeGrant(db, id, 'revogada durante teste', clock);
      return { kind: 'accepted', messageId: 'test-only', threadId: undefined, labelIds: ['SENT'] };
    });
    const report = await run();
    expect(report.counts.enviada ?? 0).toBe(0);
    expect(transport.calls).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM email_dispatches WHERE kind='real'").get(),
    ).toEqual({ n: 0 });
  });
  it('revalida o manifesto depois da pausa imediatamente anterior à reserva', async () => {
    grant();
    const report = await run({
      emailContext: {
        ...context(),
        beforeReserve: () => {
          entry().revokedAt = clock.toISOString();
          save();
        },
      },
    });
    expect(report.counts.enviada ?? 0).toBe(0);
    expect(transport.calls).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM email_dispatches').get()).toEqual({ n: 0 });
  });
  it('limite diário zero, manifesto alterado, ou trava mestra desligada impedem chamadas', async () => {
    policy = parsePolicy({ ...policy, limits: { ...policy.limits, maxPerDay: 0 } });
    grant();
    await run();
    expect(transport.calls).toHaveLength(0);
    policy = parsePolicy({ ...policy, limits: { ...policy.limits, maxPerDay: 5 } });
    grant();
    entry().validUntil = '2026-10-26T11:00:00Z';
    save();
    await run();
    expect(transport.calls).toHaveLength(0);
    policy = parsePolicy({
      ...policy,
      real: { ...policy.real, autoApplyManifestSha256: load().sha256 },
    });
    grant();
    await run({ emailContext: { ...context(), sendEnabled: false } });
    expect(transport.calls).toHaveLength(0);
  });
  it('resultado incerto exige pessoa e nunca é reenviado', async () => {
    grant();
    transport.next(
      { kind: 'accepted', messageId: 'test', threadId: undefined, labelIds: [] },
      { kind: 'unknown', category: 'timeout_ficticio' },
    );
    const report = await run();
    expect(report.counts.envio_incerto).toBe(1);
    expect(autoApplyStates(db)[0]?.state).toBe('pendente_humano');
    await run();
    expect(transport.calls).toHaveLength(2);
  });
});

describe('formulário fictício e API de envio exclusivamente em localhost', () => {
  it('preenche/anexa localmente e percorre o envio completo usando API Gmail simulada por servidor local', async () => {
    const requests: string[] = [];
    server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<form><label>Email<input id="email" type="email" required></label><label>Currículo<input id="cv" type="file" required></label><label>Li e aceito os termos<input id="terms" type="checkbox"></label><button type="submit">Enviar</button></form>',
        );
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        requests.push(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: `local-${requests.length}`, labelIds: ['SENT'] }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('servidor local ausente');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(endpoint);
      const driver = new PlaywrightPage(page);
      const form = await driver.extractForm();
      const plan = planForm(form, {
        applicant,
        salary: 1800,
        cv: { path: join(dir, 'cv.pdf'), label: 'cv.pdf' },
      });
      for (const action of plan.actions) {
        const field = form.fields.find((field) => field.id === action.fieldId);
        if (field) {
          if (action.op === 'upload') await driver.upload(field.selector, action.value);
          else if (action.op === 'fill') await driver.fill(field.selector, action.value);
        }
      }
      expect(await page.locator('#email').inputValue()).toBe(applicant.email);
      expect(
        await page
          .locator('#cv')
          .evaluate((el) => (el as unknown as { files: { length: number } }).files.length),
      ).toBe(1);
      expect(await page.locator('#terms').isChecked()).toBe(false);
      // Só o transporte documentado de e-mail envia; nenhum Submit de portal é acionado.
      const localTransport = new GmailTransport(
        { getAccessToken: () => Promise.resolve('fake-token-local-only') },
        async (url, init) => {
          expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
          return fetch(`${endpoint}/send`, init);
        },
      );
      grant();
      const report = await run({ emailContext: { ...context(), transport: localTransport } });
      expect(report.counts.enviada).toBe(1);
      expect(requests).toHaveLength(2);
      const raw = (JSON.parse(requests[1] ?? '{}') as { raw: string }).raw;
      expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain(CV_BYTES.toString('base64'));
      expect(autoApplyStates(db)[0]?.state).toBe('enviada');
      const output = process.env.AUTOESTAGIO_AUTO_APPLY_TEST_OUTPUT;
      if (output) {
        mkdirSync(output, { recursive: true, mode: 0o700 });
        await page.screenshot({ path: join(output, 'form-local.png'), fullPage: true });
        copyFileSync(
          join(dir, 'receipts', `run-${report.runId}-job-${jobId}.json`),
          join(output, 'aceite-ficticio.json'),
        );
        writeFileSync(
          join(output, 'simulation.json'),
          JSON.stringify(
            { simulated: true, externalRequests: 0, localRequests: requests.length, report },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      }
    } finally {
      await browser.close();
    }
  }, 30_000);
});
