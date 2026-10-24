import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { formatRunReport, registerAutonomoCommands, systemdUnits } from '../../src/cli/autonomo.js';
import type { RunReport } from '../../src/autonomy/index.js';

describe('CLI autonomo', () => {
  it('expõe só run, status, history, stop, resume e timer', () => {
    const program = new Command();
    registerAutonomoCommands(program, {
      withDb: () => {
        throw new Error('não deve abrir o banco');
      },
      withDbAsync: () => {
        throw new Error('não deve abrir o banco');
      },
    });
    const cmd = program.commands.find((c) => c.name() === 'autonomo');
    expect(cmd?.commands.map((c) => c.name()).sort()).toEqual([
      'diagnose',
      'grant',
      'history',
      'resume',
      'revoke',
      'run',
      'sources',
      'status',
      'stop',
      'timer',
    ]);
  });

  it('o agendamento sugerido roda só simulação e não instala nada', () => {
    const units = systemdUnits({ node: '/usr/bin/node', root: '/proj' });
    expect(units.service).toContain('WorkingDirectory=/proj');
    expect(units.service).toContain('autonomo run --trigger timer');
    expect(units.service).not.toMatch(/--real/);
    expect(units.timer).toContain('Persistent=true');
    expect(systemdUnits({ node: 'n', root: 'r', real: true }).service).toContain('--real');
  });

  it('o relatório deixa claro quando é simulação', () => {
    const report: RunReport = {
      runId: 3,
      mode: 'simulacao',
      status: 'concluida',
      discovery: null,
      analyzed: 1,
      verdicts: { apto: 1 },
      alreadyApplied: 0,
      counts: { pendente_canal: 1 },
      decisions: [
        {
          jobId: 9,
          company: 'X',
          title: 'Estágio',
          decision: 'pendente_canal',
          reasons: ['sem canal'],
          connector: 'portal-inhire',
        },
      ],
      limits: { perRun: 5, perDay: 10, sentToday: 0, effective: 5 },
      discards: [{ reason: 'elegibilidade: área fora de TI', count: 3 }],
      grantId: null,
      fresh: { total: 4, inIt: 3, apto: 1, pendente: 2, descartada: 1, automatable: 1 },
      errors: [],
      stopped: false,
      notes: [],
    };
    const out = formatRunReport(report);
    expect(out).toContain('simulação: nada é enviado');
    expect(out).toContain('candidatura manual');
    expect(out).toContain('Novas nesta execução: 4 vaga(s) — em TI: 3');
    expect(out).toContain('3× elegibilidade: área fora de TI');
  });
});
