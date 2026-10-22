import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectStatus, formatStatus } from '../src/cli/status.js';
import type { AppConfig } from '../src/config/index.js';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { PROJECT_ROOT } from '../src/utils/paths.js';

const tempDirs: string[] = [];

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
  tempDirs.push(dir);
  return {
    databasePath: join(dir, 'test.db'),
    profilePath: join(PROJECT_ROOT, 'config', 'profile.example.json'),
    applyMode: 'dry-run',
    allowAutoApply: false,
    maxApplicationsPerDay: 10,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('collectStatus', () => {
  it('não cria o banco quando ele não existe', () => {
    const config = makeConfig();
    const report = collectStatus(config);
    expect(report.database.exists).toBe(false);
    expect(formatStatus(report)).toContain('não criado');
  });

  it('reporta migrações aplicadas', () => {
    const config = makeConfig();
    const db = openDatabase(config.databasePath);
    runMigrations(db);
    db.close();

    const report = collectStatus(config);
    expect(report.database.migrations?.pending).toEqual([]);
    expect(report.database.migrations?.applied).toHaveLength(1);
    expect(formatStatus(report)).toContain('atualizado');
  });

  it('reporta perfil ausente sem falhar', () => {
    const report = collectStatus(makeConfig({ profilePath: '/caminho/inexistente.json' }));
    expect(report.profile.loaded).toBe(false);
  });

  it('mantém o modo auto desabilitado por padrão', () => {
    const report = collectStatus(makeConfig());
    expect(report.applyMode).toBe('dry-run');
    expect(report.autoApplyEnabled).toBe(false);
  });
});
