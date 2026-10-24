import { describe, expect, it } from 'vitest';
import { candidateEmail } from '../../src/autonomy/index.js';

describe('e-mail de candidatura na descrição da vaga', () => {
  it('aceita um único e-mail corporativo junto do pedido de candidatura', () => {
    expect(candidateEmail('Interessados: envie seu currículo para rh@empresa.com.br.')).toEqual({
      ok: true,
      email: 'rh@empresa.com.br',
    });
    expect(candidateEmail('Send your resume to jobs@startup.io')).toMatchObject({ ok: true });
  });

  it('não confunde endereços de acessibilidade, privacidade, suporte ou golpe com candidatura', () => {
    const shift =
      'We are committed to reasonable accommodations in our application process. Should you require accommodation, please email accommodation@shift-technology.com. Beware of scams.';
    expect(candidateEmail(shift)).toMatchObject({ ok: false });
    expect(
      candidateEmail('Envie sua dúvida de privacidade para privacidade@empresa.com.br'),
    ).toMatchObject({ ok: false });
    expect(candidateEmail('Para candidatura fale com suporte@empresa.com.br')).toMatchObject({
      ok: false,
    });
    expect(
      candidateEmail('Cuidado com golpes. Candidate-se só pelo site; contato@empresa.com.br'),
    ).toMatchObject({ ok: false });
  });

  it('sem pedido de candidatura por perto, com vários endereços ou com provedor gratuito, nada é deduzido', () => {
    expect(candidateEmail('Fale conosco: contato@empresa.com.br')).toMatchObject({ ok: false });
    expect(candidateEmail('Envie seu currículo para rh@a.com.br ou vagas@b.com.br')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('vários') as string,
    });
    expect(candidateEmail('Envie seu currículo para fulano@gmail.com')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('gratuito') as string,
    });
    expect(candidateEmail(null)).toMatchObject({ ok: false });
  });
});
