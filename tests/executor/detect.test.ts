import { describe, expect, it } from 'vitest';
import { classifyPage, findConfirmation } from '../../src/executor/detect.js';
import { form, greenhouseLike, signals } from './fixtures.js';

describe('classificação da página', () => {
  it('formulário normal passa e a proteção anti-robô vira só um aviso', () => {
    const verdict = classifyPage(signals({ captchaPresent: true }), greenhouseLike());
    expect(verdict.kind).toBe('ok');
    expect(verdict.kind === 'ok' && verdict.notes.join(' ')).toContain('anti-robô');
  });

  it('vaga encerrada, login, CAPTCHA visível, avaliação e ausência de formulário bloqueiam, cada um com o seu motivo', () => {
    const out = (s: Parameters<typeof signals>[0], f = greenhouseLike()) => {
      const v = classifyPage(signals(s), f);
      return v.kind === 'bloqueada' ? v.outcome : 'ok';
    };
    expect(out({ text: 'Inscrições encerradas! Não fique triste.' })).toBe('encerrada');
    expect(out({ text: 'This job is no longer accepting applications' })).toBe('encerrada');
    expect(
      out(
        { hasPasswordInput: true, text: 'Entrar com sua conta E-mail ou CPF Senha', fieldCount: 3 },
        form([]),
      ),
    ).toBe('login');
    expect(out({ visibleCaptchaChallenge: true })).toBe('captcha');
    expect(out({ url: 'https://app.codingame.com/x' })).toBe('avaliacao');
    expect(out({ fieldCount: 0, text: 'Faça o teste técnico online' }, form([]))).toBe('avaliacao');
    expect(out({ fieldCount: 0 }, form([]))).toBe('sem_formulario');
  });

  it('menção a avaliação na descrição não bloqueia quando há formulário (só avisa)', () => {
    const v = classifyPage(
      signals({ text: 'Etapas: entrevista e assessment técnico.' }),
      greenhouseLike(),
    );
    expect(v.kind).toBe('ok');
    expect(v.kind === 'ok' && v.notes.join(' ')).toContain('não são respondidos');
  });

  it('reconhece a confirmação da plataforma e devolve o trecho como evidência', () => {
    expect(findConfirmation('Inscrição feita com sucesso! Você se inscreveu na vaga X.')).toContain(
      'Inscrição feita com sucesso',
    );
    expect(findConfirmation('Thank you for applying to Acme')).toContain('Thank you for applying');
    expect(findConfirmation('Preencha o formulário para se candidatar')).toBeNull();
  });
});
