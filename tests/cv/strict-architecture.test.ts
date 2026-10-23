import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/utils/paths.js';

describe('fronteiras da integração estrita', () => {
  it('integração, contexto e política não persistem nem consultam rede ou banco', () => {
    for (const file of [
      'strict.ts',
      'strict-context.ts',
      'strict-completion.ts',
      'font-policy.ts',
      'decision-context.ts',
    ]) {
      const text = readFileSync(join(PROJECT_ROOT, 'src/cv', file), 'utf8');
      for (const pattern of [
        /node:fs|writeFile|createWriteStream|appendFile|mkdirSync|renameSync/,
        /better-sqlite3|openDatabase/,
        /fetch\(|node:http|node:https|node:net/,
        /process\.env|Date\.now|new Date\(\)|Math\.random/,
      ])
        expect(pattern.test(text), file).toBe(false);
    }
  });
  it('não chama funcionalidades de CLI, persistência ou envio', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'src/cv/strict.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"].*(?:cli|store|email|applications|preparation)/);
    expect(text).not.toMatch(/loadModel|saveModel|saveReport|extractPdf\(/);
  });
  it('a política só depende de crypto e possui âncoras literais, sem override', () => {
    const text = readFileSync(join(PROJECT_ROOT, 'src/cv/font-policy.ts'), 'utf8');
    expect([...text.matchAll(/from '([^']+)'/gu)].map((m) => m[1])).toEqual(['node:crypto']);
    expect(text).not.toMatch(/process\.|readFile|expectedHash\??:/);
  });
});
