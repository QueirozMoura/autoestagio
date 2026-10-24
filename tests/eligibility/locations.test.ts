import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProfile } from '../../src/config/index.js';
import { IN_MEMORY, openDatabase, runMigrations } from '../../src/db/index.js';
import {
  CommuteError,
  pendingLocations,
  registerCommute,
} from '../../src/eligibility/locations.js';
import { seedJob } from '../helpers/applications.js';
import { baseProfile, profile } from '../helpers/eligibility.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempProfile(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'locais-'));
  dirs.push(dir);
  const path = join(dir, 'profile.json');
  writeFileSync(path, JSON.stringify({ ...baseProfile, commute: [], ...extra }, null, 2), {
    mode: 0o640,
  });
  chmodSync(path, 0o640);
  return path;
}

describe('locais pendentes', () => {
  it('lista só locais presenciais/híbridos sem tempo confirmado, agrupados e sem estimar nada', () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    seedJob(db, { title: 'A', workMode: 'hibrido', location: 'São Paulo - Itaim Bibi' });
    seedJob(db, { title: 'B', workMode: 'presencial', location: 'São Paulo - Itaim Bibi' });
    seedJob(db, { title: 'C', workMode: 'presencial', location: 'Osasco, SP' });
    seedJob(db, { title: 'D', workMode: 'presencial', location: 'São Paulo - Pinheiros' }); // tem tempo no perfil de teste
    seedJob(db, { title: 'E', workMode: 'remoto', location: 'Brasil' });
    seedJob(db, { title: 'F', workMode: 'presencial', location: 'Campinas, SP' }); // outra cidade: incompatível, não pendente
    const list = pendingLocations(db, profile());
    expect(list).toEqual([
      { location: 'São Paulo - Itaim Bibi', jobs: 2, region: 'sao-paulo' },
      { location: 'Osasco, SP', jobs: 1, region: 'metropolitana' },
    ]);
    db.close();
  });
});

describe('locais registrar', () => {
  it('grava o tempo com fonte e data, valida o perfil e preserva as permissões', () => {
    const path = tempProfile();
    const result = registerCommute(
      path,
      {
        keywords: ['Itaim Bibi', 'ITAIM'],
        minutesPerWay: 62,
        source: 'Google Maps, transporte público',
      },
      new Date('2026-10-23T12:00:00Z'),
    );
    expect(result.replaced).toBe(false);
    const parsed = loadProfile(path);
    expect(parsed?.commute).toEqual([
      {
        keywords: ['itaim bibi', 'itaim'],
        minutesPerWay: 62,
        source: 'Google Maps, transporte público',
        confirmedAt: '2026-10-23',
      },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(statSync(`${path}.pre-locais.bak`).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it('as mesmas palavras substituem a entrada; a cópia de segurança guarda o estado original', () => {
    const path = tempProfile();
    const original = readFileSync(path, 'utf8');
    registerCommute(path, { keywords: ['osasco'], minutesPerWay: 70, source: 'Google Maps' });
    expect(
      registerCommute(path, {
        keywords: ['osasco'],
        minutesPerWay: 75,
        source: 'Google Maps',
        confirmedAt: '2026-10-24',
      }).replaced,
    ).toBe(true);
    registerCommute(path, { keywords: ['barueri'], minutesPerWay: 80, source: 'Google Maps' });
    const entries = loadProfile(path)?.commute ?? [];
    expect(entries.map((e) => [e.keywords[0], e.minutesPerWay])).toEqual([
      ['osasco', 75],
      ['barueri', 80],
    ]);
    expect(readFileSync(`${path}.pre-locais.bak`, 'utf8')).toBe(original);
  });

  it.each([
    [{ keywords: [' ', ''], minutesPerWay: 60, source: 'x' }, /palavra/],
    [{ keywords: ['a'], minutesPerWay: 0, source: 'x' }, /minutos/],
    [{ keywords: ['a'], minutesPerWay: 1.5, source: 'x' }, /minutos/],
    [{ keywords: ['a'], minutesPerWay: 601, source: 'x' }, /minutos/],
    [{ keywords: ['a'], minutesPerWay: 60, source: '  ' }, /verificado/],
    [{ keywords: ['a'], minutesPerWay: 60, source: 'x', confirmedAt: '23/10/2026' }, /Data/],
  ])('recusa entrada inválida sem alterar o perfil (%j)', (input, message) => {
    const path = tempProfile();
    const before = readFileSync(path, 'utf8');
    expect(() => registerCommute(path, input)).toThrow(message);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(`${path}.pre-locais.bak`)).toBe(false);
  });

  it('perfil inexistente, JSON inválido ou perfil que ficaria inválido: nada é alterado', () => {
    expect(() =>
      registerCommute(join(tmpdir(), 'nao-existe.json'), {
        keywords: ['a'],
        minutesPerWay: 60,
        source: 'x',
      }),
    ).toThrow(CommuteError);
    const broken = tempProfile();
    writeFileSync(broken, '{ não é json');
    expect(() =>
      registerCommute(broken, { keywords: ['a'], minutesPerWay: 60, source: 'x' }),
    ).toThrow(/JSON/);
    const invalid = tempProfile({ level: 'inexistente' });
    const before = readFileSync(invalid, 'utf8');
    expect(() =>
      registerCommute(invalid, { keywords: ['a'], minutesPerWay: 60, source: 'x' }),
    ).toThrow(/inválido/);
    expect(readFileSync(invalid, 'utf8')).toBe(before);
  });
});
