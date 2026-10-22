import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyApprovedCv } from '../../src/config/index.js';
import { profile } from '../helpers/eligibility.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function approvedWith(content: string, declared?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-'));
  dirs.push(dir);
  const file = join(dir, 'Curriculo_Ficticio.pdf');
  writeFileSync(file, content);
  const sha = declared ?? createHash('sha256').update(content).digest('hex');
  return profile({ approval: { cvFile: file, cvSha256: sha, approvedAt: '2026-10-22' } });
}

describe('verifyApprovedCv', () => {
  it('aceita o arquivo cujo SHA-256 é o aprovado e devolve só o nome do arquivo', () => {
    const check = verifyApprovedCv(approvedWith('conteudo'));
    expect(check).toMatchObject({ ok: true, cv: { label: 'Curriculo_Ficticio.pdf' } });
  });

  it('recusa quando o arquivo foi alterado depois da aprovação', () => {
    const check = verifyApprovedCv(approvedWith('conteudo', 'f'.repeat(64)));
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/difere do aprovado/);
  });

  it('recusa quando o arquivo sumiu ou não há aprovação', () => {
    const missing = verifyApprovedCv(profile());
    expect(!missing.ok && missing.reason).toMatch(/não encontrado/);
    expect(verifyApprovedCv(profile({ approval: undefined }))).toMatchObject({ ok: false });
  });
});
