import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import {
  launchSession,
  loadApplicant,
  runExecutor,
  type BrowserSession,
  type ExecRunReport,
} from '../executor/index.js';
import type { Policy } from './policy.js';

/** Somente formulários das plataformas já utilizadas; demais hosts exigem revisão. */
export const PREPARATION_HOSTS = [
  'job-boards.greenhouse.io',
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.eu.lever.co',
  'jobs.ashbyhq.com',
] as const;

export async function prepareUnattended(options: {
  db: Db;
  profile: Profile;
  policy: Policy;
  root: string;
  stopFile: string;
  planOnly?: boolean;
  /** Testes podem fornecer navegador com páginas locais/simuladas. */
  session?: BrowserSession;
}): Promise<ExecRunReport> {
  const { db, policy } = options;
  // Depois de uma queda, não repetir o preenchimento: pode ter havido intervenção no portal.
  db.prepare(
    "UPDATE autonomous_queue SET status = 'pendente_humano', notes = 'Preparo anterior interrompido: conferir antes de retomar.', updated_at = ? WHERE status = 'em_andamento' AND updated_at < ?",
  ).run(
    new Date().toISOString(),
    new Date(Date.now() - policy.limits.lockTtlMinutes * 60_000).toISOString(),
  );
  const ready = db
    .prepare(
      "SELECT COUNT(*) AS n FROM autonomous_queue WHERE flow = 'assistido' AND status = 'pronta' AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = autonomous_queue.job_id)",
    )
    .get() as { n: number };
  if (ready.n === 0 || existsSync(options.stopFile) || policy.limits.maxPerRun === 0)
    return { mode: options.planOnly ? 'planejar' : 'preparar', items: [], remainingReady: ready.n };
  const applicant = loadApplicant(join(options.root, 'config/applicant.json'));
  const session =
    options.session ??
    (await launchSession({
      profileDir: join(options.root, 'data/browser-profile-nightly'),
      headless: true,
      allowedDocumentHosts: PREPARATION_HOSTS,
    }));
  try {
    return await runExecutor({
      db,
      profile: options.profile,
      applicant,
      salary: policy.salaryExpectation.amount,
      session,
      mode: options.planOnly ? 'planejar' : 'preparar',
      max: policy.limits.maxPerRun,
      outputDir: join(options.root, 'data/exec'),
      cvDir: join(options.root, 'data/cv-output'),
      unattended: true,
      allowedHosts: PREPARATION_HOSTS,
      shouldStop: () => existsSync(options.stopFile),
    });
  } finally {
    if (options.session === undefined) await session.close();
  }
}
