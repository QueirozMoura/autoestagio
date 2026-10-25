import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations } from '../../src/db/index.js';
import { runRealScan } from '../../src/discovery/real-scan.js';
import { HttpClient } from '../../src/http/index.js';
import { parseSourcesConfig } from '../../src/sources/index.js';
import { parsePolicy } from '../../src/autonomy/policy.js';
import { runAutonomous } from '../../src/autonomy/run.js';
import { prepareUnattended } from '../../src/autonomy/preparation.js';
import { saveMorningReport } from '../../src/autonomy/report.js';
import {
  PlaywrightPage,
  findBrowser,
  type BrowserSession,
  type PageDriver,
} from '../../src/executor/index.js';
import { profile } from '../helpers/eligibility.js';
import { applicant } from '../executor/fixtures.js';
import { jsonResponse, mockFetch, textResponse } from '../helpers/mock-fetch.js';

describe('rotina noturna completa, dados fictícios e HTML local', () => {
  it('descobre, analisa, monta fila, preenche/anexa, captura bloqueios e produz relatório sem interação nem envio', async () => {
    const root = mkdtempSync(join(tmpdir(), 'overnight-'));
    const db = openDatabase(join(root, 'test.db'));
    const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
    const context = await browser.newContext();
    const forbiddenRequests: string[] = [];
    await context.route('**/*', async (route) => {
      forbiddenRequests.push(route.request().url());
      await route.abort();
    });
    try {
      runMigrations(db);
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(join(root, 'config/applicant.json'), JSON.stringify(applicant));
      const pdf = join(root, 'approved.pdf');
      writeFileSync(pdf, '%PDF-1.4\n% fictício para teste\n');
      const candidate = profile({
        approval: {
          cvFile: pdf,
          cvSha256: createHash('sha256').update(readFileSync(pdf)).digest('hex'),
          approvedAt: '2026-10-24',
        },
      });
      const policy = parsePolicy({
        limits: { maxPerRun: 20, maxPerDay: 20 },
        rules: { tolerateUnknown: ['bolsa', 'modalidade'] },
      });
      const url = (id: number) =>
        id === 10
          ? 'https://www.linkedin.com/jobs/view/10'
          : `https://job-boards.greenhouse.io/ficticio/jobs/${id}`;
      const listed = Array.from({ length: 10 }, (_, index) => ({
        id: index + 1,
        title:
          index === 7
            ? 'Estágio em Marketing'
            : `Estágio em Desenvolvimento de Software ${index + 1}`,
        absolute_url: url(index + 1),
        location: { name: 'Remote - Brazil' },
      }));
      const endpoint = 'https://boards-api.greenhouse.io/v1/boards/ficticio/jobs';
      const mock = mockFetch({
        'https://boards-api.greenhouse.io/robots.txt': textResponse('User-agent: *\nAllow: /'),
        [endpoint]: jsonResponse({ jobs: listed }),
        ...Object.fromEntries(
          listed.map((job) => [
            `${endpoint}/${job.id}`,
            jsonResponse({
              ...job,
              content:
                '<p>Trabalho remoto. Bolsa R$ 1.800 mensais. Desenvolvimento de software com TypeScript e SQL.</p>' +
                (job.id === 7
                  ? '<p>Envie seu currículo para recrutamento@empresa-ficticia.com.br</p>'
                  : ''),
            }),
          ]),
        ),
      });
      let visits = 0;
      const html = (id: number) =>
        `<html><body><h1>Candidatura fictícia ${id}</h1>${id === 3 ? '<input type="password"><p>Entrar com sua conta</p>' : id === 4 ? '<p>Teste técnico / assessment</p>' : `<form onsubmit="document.body.dataset.submitted='yes';return false"><label>First Name<input name="name" required></label><label>Email<input type="email" required></label><label>Currículo<input type="file" required></label>${id === 5 ? '<label>Qual seu nível de Kubernetes?<input required></label>' : ''}<label>Li e aceito os termos<input type="checkbox"></label><button type="submit">Submit application</button></form>`}</body></html>`;
      const session: BrowserSession = {
        close: async () => {
          await context.close();
        },
        newPage: async (): Promise<PageDriver> => {
          const page = await context.newPage();
          const driver = new PlaywrightPage(page);
          let id = 0;
          return {
            goto: async (target) => {
              id = Number(new URL(target).pathname.split('/').at(-1));
              visits++;
              await page.setContent(html(id));
            },
            signals: async () => ({
              ...(await driver.signals()),
              url: url(id),
              visibleCaptchaChallenge: id === 2,
            }),
            extractForm: () => driver.extractForm(),
            fill: (selector, value) => driver.fill(selector, value),
            select: (selector, value) => driver.select(selector, value),
            choose: (selector, value) => driver.choose(selector, value),
            upload: (selector, path) =>
              id === 6
                ? Promise.reject(new Error('upload bloqueado no teste'))
                : driver.upload(selector, path),
            screenshot: (path) => driver.screenshot(path),
            text: () => driver.text(),
            close: async () => {
              expect(await page.getAttribute('body', 'data-submitted')).toBeNull();
              await driver.close();
            },
          };
        },
      };
      const report = await runAutonomous({
        db,
        profile: candidate,
        policy,
        mode: 'simulacao',
        trigger: 'timer',
        discover: async () => {
          const scan = await runRealScan({
            db,
            config: parseSourcesConfig({
              targets: [{ kind: 'greenhouse', slug: 'ficticio', name: 'Empresa Fictícia' }],
            }),
            http: new HttpClient({ fetch: mock.fetch, minIntervalMs: 0 }),
          });
          return {
            found: scan.totals.found,
            newJobs: scan.totals.new,
            updatedJobs: scan.totals.updated,
            errors: scan.sources.flatMap((source) => (source.error ? [source.error] : [])),
          };
        },
        prepare: () =>
          prepareUnattended({
            db,
            profile: candidate,
            policy,
            root,
            stopFile: join(root, 'STOP'),
            session,
          }),
      });
      const paths = saveMorningReport(db, report, join(root, 'reports'));
      const morning = JSON.parse(readFileSync(paths.json, 'utf8')) as {
        summary: Record<string, number | null>;
      };
      expect(report.status).toBe('concluida');
      expect(report.errors).toEqual([]);
      expect(report.discovery).toMatchObject({ found: 10, newJobs: 10, errors: [] });
      expect(report.preparation?.items.map((item) => item.outcome).sort()).toEqual(
        [
          'pronto_para_revisao',
          'captcha',
          'login',
          'avaliacao',
          'campos_desconhecidos',
          'campos_desconhecidos',
          'pronto_para_revisao',
          'erro',
        ].sort(),
      );
      expect(morning.summary).toMatchObject({
        found: 10,
        prepared: 2,
        partiallyPrepared: 2,
        autoChannelCompatible: 1,
        wouldSend: 1,
        sent: 0,
        humanRequired: 8,
      });
      expect(report.preparation?.items.filter((item) => item.screenshot !== null)).toHaveLength(7);
      expect(
        report.preparation?.items.every(
          (item) => item.screenshot === null || existsSync(item.screenshot),
        ),
      ).toBe(true);
      expect(visits).toBe(7);
      expect(forbiddenRequests).toEqual([]);
      expect(
        mock.calls.every((call) => call.init?.method === 'GET' || call.init?.method === undefined),
      ).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM autonomous_grants').get()).toEqual({ n: 0 });
      expect(
        report.preparation?.items
          .flatMap((item) => item.filled)
          .some((field) => /termos/.test(field.label)),
      ).toBe(false);
      // A mesma rotina não retoma automaticamente as oito pendências na próxima madrugada.
      const repeated = await runAutonomous({
        db,
        profile: candidate,
        policy,
        mode: 'simulacao',
        prepare: () =>
          prepareUnattended({
            db,
            profile: candidate,
            policy,
            root,
            stopFile: join(root, 'STOP'),
            session,
          }),
      });
      expect(repeated.preparation?.items).toEqual([]);
      const artifact = process.env.AUTOESTAGIO_SIMULATION_OUTPUT;
      if (artifact) {
        mkdirSync(artifact, { recursive: true });
        const screenshots = join(artifact, 'screenshots');
        mkdirSync(screenshots, { recursive: true });
        for (const item of report.preparation?.items ?? []) {
          if (item.screenshot !== null)
            copyFileSync(
              item.screenshot,
              join(screenshots, item.screenshot.split('/').at(-1) ?? 'capture.png'),
            );
        }
        writeFileSync(
          join(artifact, 'simulation.json'),
          JSON.stringify(morning, null, 2).replaceAll(join(root, 'data/exec'), screenshots),
          {
            mode: 0o600,
          },
        );
        writeFileSync(
          join(artifact, 'simulation.md'),
          readFileSync(paths.markdown, 'utf8').replaceAll(join(root, 'data/exec'), screenshots),
          {
            mode: 0o600,
          },
        );
      }
    } finally {
      await browser.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
