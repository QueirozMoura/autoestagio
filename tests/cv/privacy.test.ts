import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/utils/paths.js';

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' });
const isGitRepo = ((): boolean => {
  try {
    return git('rev-parse', '--is-inside-work-tree').trim() === 'true';
  } catch {
    return false;
  }
})();

/** Arquivos locais com dados pessoais, declarações, backups e relatórios: nunca no Git. */
const LOCAL_ONLY = [
  'config/cv-master.json',
  'config/cv-master.json.bak',
  'config/profile.json',
  'data/cv-declarations.json',
  'data/cv-declarations.pre-curadoria.bak',
  'data/cv-master.pre-curadoria.bak',
  'data/cv-reports/cv-report.20261022T120000.json',
  'data/autoestagio.db',
  'data/backups/qualquer.bak',
];

describe('dados pessoais e declarações locais ficam fora do Git', () => {
  it('o .gitignore cobre o modelo, o backup do modelo e toda a pasta data/', () => {
    const ignore = readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('config/cv-master.json');
    expect(ignore).toContain('config/cv-master.json.bak');
    expect(ignore).toMatch(/^data\/\*$/m);
    expect(ignore).toMatch(/^!data\/\.gitkeep$/m);
  });

  it.skipIf(!isGitRepo)('o git ignora cada arquivo local sensível (git check-ignore)', () => {
    for (const path of LOCAL_ONLY) {
      let ignored = true;
      try {
        git('check-ignore', '--quiet', path);
      } catch {
        ignored = false;
      }
      expect(ignored, `${path} deveria estar ignorado`).toBe(true);
    }
  });

  it.skipIf(!isGitRepo)('nenhum arquivo local sensível está versionado', () => {
    const tracked = git('ls-files').split('\n').filter(Boolean);
    for (const path of LOCAL_ONLY) expect(tracked).not.toContain(path);
    // Em data/ só o marcador da pasta; em config/ só os exemplos.
    expect(tracked.filter((p) => p.startsWith('data/'))).toEqual(['data/.gitkeep']);
    expect(tracked.filter((p) => p.startsWith('config/') && !p.includes('.example.'))).toEqual([]);
    expect(tracked.some((p) => /(^|\/)\.env($|\.(?!example))/.test(p))).toBe(false);
  });
});
