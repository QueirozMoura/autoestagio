import { describe, expect, it } from 'vitest';
import type {
  Application,
  ApplicationEvent,
  ApplicationSummary,
} from '../../src/applications/index.js';
import {
  formatApplication,
  formatApplicationList,
  formatCounts,
  formatHistory,
} from '../../src/cli/applications.js';

const application: Application = {
  id: 3,
  jobId: 9,
  mode: 'revisao',
  status: 'entrega_confirmada',
  channel: 'email',
  cvSha256: '0123456789abcdef'.repeat(4),
  cvLabel: 'Curriculo_Ficticio.pdf',
  eligibilityVerdict: 'apto',
  eligibilityOverrideReason: null,
  profileHash: 'perfil-secreto-hash',
  hasConfirmation: true,
  appliedAt: '2026-10-22T12:00:00.000Z',
  createdAt: '2026-10-22T11:00:00.000Z',
  updatedAt: '2026-10-22T12:05:00.000Z',
};

describe('saída da CLI de candidaturas', () => {
  it('mostra o essencial para auditar e só um trecho do SHA-256', () => {
    const text = formatApplication(application);
    expect(text).toContain('entrega confirmada');
    expect(text).toContain('Curriculo_Ficticio.pdf');
    expect(text).toContain('0123456789ab…');
    expect(text).not.toContain(application.cvSha256);
    expect(text).toContain('confirmação: registrada');
  });

  it('nunca expõe hash do perfil, caminhos, e-mails nem evidências de confirmação', () => {
    const summary: ApplicationSummary = {
      ...application,
      title: 'Estágio',
      company: 'Acme',
      jobUrl: 'https://e.com/1',
    };
    const all = [
      formatApplication(application),
      formatApplicationList([summary]),
      JSON.stringify(Object.keys(application)),
    ].join('\n');
    expect(all).not.toContain('perfil-secreto-hash');
    expect(all).not.toMatch(/@|\/home\//);
  });

  it('histórico traz data, transição, ator, modo, canal e motivo', () => {
    const event: ApplicationEvent = {
      id: 1,
      applicationId: 3,
      fromStatus: 'enviada',
      toStatus: 'entrega_confirmada',
      mode: 'revisao',
      channel: 'email',
      actor: 'sistema',
      reason: 'provedor confirmou a entrega',
      createdAt: '2026-10-22T12:05:00.000Z',
    };
    expect(formatHistory([event])).toBe(
      '2026-10-22T12:05:00.000Z  enviada → entrega_confirmada  [sistema, modo revisao, canal email]\n    provedor confirmou a entrega',
    );
    expect(formatHistory([])).toBe('Sem eventos.');
    expect(formatApplicationList([])).toBe('Nenhuma candidatura registrada.');
    expect(
      formatCounts({
        preparada: 2,
        aprovada_para_envio: 0,
        enviando: 0,
        enviada: 0,
        entrega_confirmada: 1,
        falhou: 0,
        pendente_intervencao_humana: 0,
      }),
    ).toContain('entrega confirmada');
  });
});
