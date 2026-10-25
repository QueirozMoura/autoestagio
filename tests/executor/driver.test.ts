import { describe, expect, it } from 'vitest';
import { assertSafeUrl } from '../../src/executor/driver.js';

describe('restrições de acesso do executor', () => {
  it.each([
    'www.linkedin.com',
    'br.indeed.com',
    'indeed.com.br',
    'www.catho.com.br',
    'www.infojobs.com.br',
    'vagas.solides.com.br',
    'auth.vagas.solides.com.br',
    'solides.jobs',
    'www.linkedin.com.',
  ])('bloqueia %s antes de navegar', (host) => {
    expect(() => assertSafeUrl(`https://${host}/vaga/123`)).toThrow('Plataforma restrita');
  });
  it('preserva a candidatura oficial da Artefact no Greenhouse', () => {
    expect(
      assertSafeUrl('https://job-boards.greenhouse.io/artefactlinkedin/jobs/7306842002').hostname,
    ).toBe('job-boards.greenhouse.io');
  });
});
