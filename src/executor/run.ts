import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../config/index.js';
import type { Db } from '../db/index.js';
import { setQueueStatus } from '../autonomy/queue.js';
import type { Applicant } from './applicant.js';
import { chooseCv, type ChosenCv } from './cv.js';
import { classifyPage, findConfirmation } from './detect.js';
import { ExecutorError, assertSafeUrl, type BrowserSession, type PageDriver } from './driver.js';
import { displayValue, planForm } from './plan.js';
import type { ExecOutcome, FillAction, FillPlan, FormModel, Step } from './types.js';

/**
 * Executor assistido: lê a próxima vaga PRONTA do fluxo assistido na fila, abre o link oficial, identifica os campos,
 * preenche só o que é comprovado, anexa o currículo aprovado e PARA antes do envio, deixando o relatório para a sua
 * revisão. Nunca envia (o contrato do navegador nem tem "clicar") e nunca marca "concluída" sem evidência da
 * plataforma. Uma vaga bloqueada (login, CAPTCHA visível, avaliação, vaga encerrada, campo desconhecido) não impede
 * as demais: o item vira "pendente_humano" com o motivo e a execução segue.
 */
export type ExecMode = 'planejar' | 'preparar';

export interface ExecOptions {
  db: Db;
  profile: Profile;
  applicant: Applicant;
  /** Pretensão salarial mensal (política). */
  salary: number;
  session: BrowserSession;
  mode: ExecMode;
  /** Quantas vagas processar nesta execução. */
  max: number;
  /** Processa só este item da fila. */
  itemId?: number;
  outputDir: string;
  /** Pasta dos PDFs de currículo por variante. */
  cvDir: string;
  /** Depois de preencher, entrega a página a você; devolve true se aguardou a sua decisão. */
  review?: (item: ExecItemReport, page: PageDriver) => Promise<void>;
  now?: () => Date;
}

export interface ExecItemReport {
  queueId: number;
  jobId: number;
  company: string | null;
  title: string;
  url: string;
  outcome: ExecOutcome;
  steps: Step[];
  filled: { label: string; source: string; value: string; readBack: string; ok: boolean }[];
  needsHuman: FillPlan['needsHuman'];
  skipped: FillPlan['skipped'];
  planned: { label: string; source: string; value: string }[];
  cv: { label: string; sha8: string; sha256: string; note: string } | null;
  notes: string[];
  screenshot: string | null;
  evidence: string | null;
}

export interface ExecRunReport {
  mode: ExecMode;
  items: ExecItemReport[];
  remainingReady: number;
}

interface QueueRow {
  id: number;
  job_id: number;
  cv_variant: string | null;
  company: string | null;
  title: string;
  url: string;
  apply_url: string | null;
}

const OUTCOME_NOTE: Record<ExecOutcome, string> = {
  pronto_para_revisao: 'preenchida e aguardando a sua revisão e envio',
  campos_desconhecidos: 'preenchida em parte; há perguntas obrigatórias que dependem de você',
  login: 'exige login na sua conta',
  captcha: 'desafio de CAPTCHA visível: só você resolve',
  avaliacao: 'exige avaliação/teste: só você faz',
  encerrada: 'vaga encerrada (a página informa)',
  sem_formulario: 'formulário não encontrado',
  erro: 'erro ao preparar; veja o relatório',
  concluida_com_evidencia: 'concluída com evidência da plataforma',
};

const pickNext = (
  db: Db,
  itemId: number | undefined,
  taken: ReadonlySet<number>,
): QueueRow | undefined =>
  (
    db
      .prepare(
        `SELECT q.id, q.job_id, q.cv_variant, j.company, j.title, j.url, j.apply_url
           FROM autonomous_queue q JOIN jobs j ON j.id = q.job_id
          WHERE q.flow = 'assistido' AND q.status = 'pronta' AND (@id IS NULL OR q.id = @id)
          ORDER BY q.priority`,
      )
      .all({ id: itemId ?? null }) as QueueRow[]
  ).find((row) => !taken.has(row.id));

/** Reserva o item (pronta → em_andamento) de forma atômica: dois executores nunca pegam o mesmo. */
function reserve(db: Db, queueId: number, at: Date): boolean {
  return (
    db
      .prepare(
        "UPDATE autonomous_queue SET status = 'em_andamento', updated_at = ? WHERE id = ? AND status = 'pronta'",
      )
      .run(at.toISOString(), queueId).changes === 1
  );
}

export async function runExecutor(options: ExecOptions): Promise<ExecRunReport> {
  const { db } = options;
  const clock = options.now ?? (() => new Date());
  const reports: ExecItemReport[] = [];
  const taken = new Set<number>();
  mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });

  while (reports.length < options.max) {
    const row = pickNext(db, options.itemId, taken);
    if (row === undefined) break;
    taken.add(row.id);
    if (!reserve(db, row.id, clock())) continue;
    reports.push(await processItem(options, row));
    if (options.itemId !== undefined) break;
  }
  const remaining = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM autonomous_queue WHERE flow = 'assistido' AND status = 'pronta'",
      )
      .get() as { n: number }
  ).n;
  return { mode: options.mode, items: reports, remainingReady: remaining };
}

async function processItem(options: ExecOptions, row: QueueRow): Promise<ExecItemReport> {
  const { applicant } = options;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock();
  const steps: Step[] = [];
  const report: ExecItemReport = {
    queueId: row.id,
    jobId: row.job_id,
    company: row.company,
    title: row.title,
    url: '',
    outcome: 'erro',
    steps,
    filled: [],
    needsHuman: [],
    skipped: [],
    planned: [],
    cv: null,
    notes: [],
    screenshot: null,
    evidence: null,
  };
  const step = (name: string, state: Step['state'], detail: string): void => {
    steps.push({ step: name, state, detail });
  };
  step('selecionar_item', 'ok', `fila #${row.id}, vaga ${row.job_id}`);
  let page: PageDriver | undefined;
  try {
    const target = row.apply_url ?? row.url;
    const link = assertSafeUrl(target);
    report.url = `${link.origin}${link.pathname}`;
    page = await options.session.newPage();
    await page.goto(link.toString());
    step('abrir_link', 'ok', report.url);

    const signals = await page.signals();
    const form: FormModel | null = signals.fieldCount > 0 ? await page.extractForm() : null;
    const verdict = classifyPage(signals, form);
    if (verdict.kind === 'bloqueada') {
      step('classificar_pagina', 'bloqueado', verdict.why);
      report.outcome = verdict.outcome;
      report.notes.push(verdict.why);
      return await finish(options, row, report, startedAt, page);
    }
    step(
      'classificar_pagina',
      'ok',
      verdict.notes.length > 0 ? verdict.notes.join('; ') : 'sem bloqueios',
    );
    report.notes.push(...verdict.notes);
    const model = form as FormModel;
    step('identificar_campos', 'ok', `${model.fields.length} campo(s)`);

    const cv = chooseCv({
      variant: row.cv_variant,
      outputDir: options.cvDir,
      profile: options.profile,
    });
    if (cv === null)
      step('selecionar_curriculo', 'bloqueado', 'nenhum currículo aprovado disponível');
    else {
      report.cv = {
        label: cv.label,
        sha8: cv.sha256.slice(0, 8),
        sha256: cv.sha256,
        note: cv.note,
      };
      step('selecionar_curriculo', 'ok', `${cv.label} (${cv.note}; sha ${cv.sha256.slice(0, 8)})`);
    }
    const plan = planForm(model, {
      applicant,
      salary: options.salary,
      cv: cv === null ? null : { path: cv.path, label: cv.label },
      profile: {
        course: options.profile.education.course,
        institution: options.profile.education.institution,
        graduationYear: options.profile.education.expectedGraduationYear,
        graduationMonth: options.profile.education.expectedGraduationMonth,
        languages: options.profile.languages ?? [],
      },
    });
    report.needsHuman = plan.needsHuman;
    report.skipped = plan.skipped;
    report.planned = plan.actions.map((a) => ({
      label: a.label,
      source: a.source,
      value: a.op === 'upload' ? (cv?.label ?? a.value) : displayValue(a, applicant),
    }));
    step(
      'planejar_preenchimento',
      'ok',
      `${plan.actions.length} a preencher; ${plan.needsHuman.length} com você; ${plan.skipped.length} opcional(is) em branco`,
    );

    if (options.mode === 'preparar')
      await apply(page, model, plan.actions, report, cv, applicant, step);
    else step('preencher', 'pulado', 'modo planejar: nada foi preenchido nem anexado');

    const missing = plan.needsHuman.filter((h) => h.required);
    report.outcome = missing.length > 0 ? 'campos_desconhecidos' : 'pronto_para_revisao';
    if (report.filled.some((f) => !f.ok)) {
      report.outcome = 'campos_desconhecidos';
      report.notes.push('algum campo não aceitou o valor: revise na página');
    }
    if (options.mode === 'preparar') {
      const shot = join(
        options.outputDir,
        `fila-${row.id}-${startedAt.toISOString().replace(/[:.]/g, '-')}.png`,
      );
      await page.screenshot(shot);
      report.screenshot = shot;
      step('captura_de_tela', 'ok', 'salva em data/ (pode conter seus dados)');
    }
    step('parar_antes_do_envio', 'ok', 'o executor não envia: o envio é seu');
    if (options.review !== undefined && options.mode === 'preparar') {
      await options.review(report, page);
      const confirmation = findConfirmation(await page.text());
      if (confirmation !== null) {
        report.evidence = `${report.url}: ${confirmation}`;
        report.outcome = 'concluida_com_evidencia';
        step('confirmacao_da_plataforma', 'ok', confirmation);
      } else step('confirmacao_da_plataforma', 'pulado', 'nenhuma confirmação foi vista na página');
    }
  } catch (error) {
    report.outcome = 'erro';
    const message =
      error instanceof ExecutorError
        ? error.message
        : `${(error as Error).name}: falha ao operar a página`;
    step('erro', 'falhou', message.slice(0, 200));
    report.notes.push(message.slice(0, 200));
  }
  return finish(options, row, report, startedAt, page);
}

const digits = (value: string): string => value.replace(/\D/g, '');

/** O que a página mostra equivale ao que se quis escrever? Telefone aceita com ou sem o código do país. */
function matches(action: FillAction, readBack: string): boolean {
  if (action.op === 'upload') return readBack !== '';
  if (action.op === 'select')
    return readBack.toLowerCase().includes(action.value.toLowerCase().slice(0, 4));
  const wanted = digits(action.value);
  if (action.source === 'applicant.phone') {
    const national = wanted.startsWith('55') ? wanted.slice(2) : wanted;
    return national !== '' && digits(readBack).endsWith(national);
  }
  if (wanted !== '' && /\d/.test(action.value) && digits(readBack) === wanted) return true;
  return readBack.trim().toLowerCase() === action.value.trim().toLowerCase();
}

async function apply(
  page: PageDriver,
  form: FormModel,
  actions: readonly FillAction[],
  report: ExecItemReport,
  cv: ChosenCv | null,
  applicant: Applicant,
  step: (name: string, state: Step['state'], detail: string) => void,
): Promise<void> {
  const byId = new Map(form.fields.map((f) => [f.id, f]));
  for (const action of actions) {
    const field = byId.get(action.fieldId);
    if (field === undefined) continue;
    const shown = action.op === 'upload' ? (cv?.label ?? '') : displayValue(action, applicant);
    try {
      let readBack = '';
      let ok = false;
      const attempts =
        action.op === 'fill' ? [action.value, ...(action.alternatives ?? [])] : [action.value];
      for (const attempt of attempts) {
        readBack =
          action.op === 'upload'
            ? await page.upload(field.selector, attempt)
            : action.op === 'select'
              ? await page.select(field.selector, attempt)
              : await page.fill(field.selector, attempt);
        ok = matches(action, readBack);
        if (ok) break;
      }
      report.filled.push({
        label: action.label,
        source: action.source,
        value: shown,
        readBack: action.masked ? '(conferido)' : readBack,
        ok,
      });
    } catch {
      report.filled.push({
        label: action.label,
        source: action.source,
        value: shown,
        readBack: '',
        ok: false,
      });
    }
  }
  const failed = report.filled.filter((f) => !f.ok).length;
  step(
    'preencher',
    failed === 0 ? 'ok' : 'falhou',
    `${report.filled.length - failed} de ${report.filled.length} campo(s) conferidos na página`,
  );
  const upload = report.filled.find((f) => f.source.startsWith('curriculo:'));
  step(
    'anexar_curriculo',
    upload === undefined ? 'pulado' : upload.ok ? 'ok' : 'falhou',
    upload === undefined ? 'sem campo de currículo' : upload.value,
  );
}

async function finish(
  options: ExecOptions,
  row: QueueRow,
  report: ExecItemReport,
  startedAt: Date,
  page: PageDriver | undefined,
): Promise<ExecItemReport> {
  const { db } = options;
  const at = (options.now ?? (() => new Date()))();
  if (page !== undefined) await page.close();
  db.prepare(
    `INSERT INTO autonomous_executions
       (queue_id, mode, outcome, started_at, finished_at, steps, fields, cv_label, cv_sha256, screenshot, evidence)
     VALUES (@queue, @mode, @outcome, @start, @end, @steps, @fields, @cvLabel, @cvSha, @shot, @evidence)`,
  ).run({
    queue: row.id,
    mode: options.mode,
    outcome: report.outcome,
    start: startedAt.toISOString(),
    end: at.toISOString(),
    steps: JSON.stringify(report.steps),
    fields: JSON.stringify({
      filled: report.filled,
      planned: report.planned,
      needsHuman: report.needsHuman,
      skipped: report.skipped,
    }),
    cvLabel: report.cv?.label ?? null,
    cvSha: report.cv?.sha256 ?? null,
    shot: report.screenshot,
    evidence: report.evidence,
  });
  const note = `${OUTCOME_NOTE[report.outcome]}${
    report.needsHuman.length > 0
      ? ` | com você: ${report.needsHuman
          .map((h) => h.label)
          .slice(0, 5)
          .join('; ')}`
      : ''
  }`.slice(0, 280);
  if (report.outcome === 'concluida_com_evidencia' && report.evidence !== null)
    setQueueStatus(db, row.id, { status: 'concluida', evidence: report.evidence, notes: note }, at);
  else if (report.outcome === 'encerrada')
    setQueueStatus(
      db,
      row.id,
      { status: 'cancelada', reason: 'vaga encerrada (a página informa)', notes: note },
      at,
    );
  else if (options.mode === 'planejar')
    // Planejar não consome o item: ele volta para a fila exatamente como estava.
    db.prepare(
      "UPDATE autonomous_queue SET status = 'pronta', updated_at = ? WHERE id = ? AND status = 'em_andamento'",
    ).run(at.toISOString(), row.id);
  else setQueueStatus(db, row.id, { status: 'pendente_humano', notes: note }, at);
  return report;
}
