import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { registerApplyCommands } from '../../src/cli/apply-commands.js';
import { registerEmailCommands } from '../../src/cli/email-commands.js';
import {
  DEFAULT_MIGRATIONS_DIR,
  IN_MEMORY,
  getMigrationStatus,
  openDatabase,
  runMigrations,
} from '../../src/db/index.js';
import { sendEmail } from '../../src/email/index.js';
import { authorizeConfirmed, setupApproved } from '../helpers/email.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function before0009(): string {
  const dir = mkdtempSync(join(tmpdir(), 'autoestagio-'));
  dirs.push(dir);
  for (const name of readdirSync(DEFAULT_MIGRATIONS_DIR))
    if (name < '0009') copyFileSync(join(DEFAULT_MIGRATIONS_DIR, name), join(dir, name));
  return dir;
}

describe('migração 0009 (evidência de teste)', () => {
  it('é aditiva: preserva despachos existentes (coluna NULL), é idempotente e não toca outras tabelas', () => {
    const old = openDatabase(IN_MEMORY);
    runMigrations(old, before0009());
    const s = setupApproved(old, { approve: false, testEvidence: false });
    // Despacho "antigo" (formato anterior à coluna): envio real aceito.
    const auth = Number(
      old
        .prepare(
          "INSERT INTO email_authorizations (application_id, kind, binding_hash, reason, created_at, expires_at, used_at) VALUES (?, 'teste', ?, 'x', 'a', 'b', 'c')",
        )
        .run(s.applicationId, 'e'.repeat(64)).lastInsertRowid,
    );
    old
      .prepare(
        "INSERT INTO email_dispatches (application_id, kind, recipient_masked, status, rfc_message_id, cv_sha256, content_hash, authorization_id, reserved_at) VALUES (?, 'teste', 'm***@x.org', 'aceito', '<a@b>', ?, 'h', ?, '2026-10-22T12:00:00.000Z')",
      )
      .run(s.applicationId, 'a'.repeat(64), auth);
    const rows = old.prepare('SELECT * FROM email_dispatches').all();
    const apps = old.prepare('SELECT * FROM applications').all();
    expect(runMigrations(old)).toEqual(['0009_email_test_evidence.sql']);
    expect(runMigrations(old)).toEqual([]);
    expect(old.prepare('SELECT * FROM applications').all()).toEqual(apps);
    expect(
      (old.prepare('SELECT * FROM email_dispatches').all() as Record<string, unknown>[]).map(
        ({ intended_binding_hash, ...rest }) => {
          expect(intended_binding_hash).toBeNull();
          return rest;
        },
      ),
    ).toEqual(rows);
    expect(old.pragma('foreign_key_check')).toEqual([]);
    expect(old.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(getMigrationStatus(old).pending).toEqual([]);
    // Uma evidência nasce só na criação e só em teste: o antigo continua sem evidência.
    expect(() =>
      old.prepare('UPDATE email_dispatches SET intended_binding_hash = ?').run('f'.repeat(64)),
    ).toThrow(/só é gravada na criação/);
    old.close();
  });

  it('rejeita hash malformado e evidência em envio real', async () => {
    const db = openDatabase(IN_MEMORY);
    runMigrations(db);
    const s = setupApproved(db);
    const authorization = authorizeConfirmed(s.ctx, s.applicationId, 'real', 'a');
    await sendEmail(s.ctx, s.applicationId, authorization.id, 'real');
    expect(
      db
        .prepare("SELECT intended_binding_hash AS h FROM email_dispatches WHERE kind = 'real'")
        .get(),
    ).toEqual({ h: null });
    const insert = (kind: string, hash: string) =>
      db
        .prepare(
          `INSERT INTO email_dispatches (application_id, kind, recipient_id, recipient_masked, status, rfc_message_id, cv_sha256, content_hash,
             authorization_id, reserved_at, intended_binding_hash) VALUES (?, ?, 1, 'x', 'rejeitado', '<z@y>', ?, 'h', ?, 'now', ?)`,
        )
        .run(s.applicationId, kind, 'a'.repeat(64), authorization.id, hash);
    expect(() => insert('teste', 'curto')).toThrow(/CHECK/);
    expect(() => insert('teste', 'A'.repeat(64))).toThrow(/CHECK/);
    expect(() => insert('real', 'a'.repeat(64))).toThrow(/só um envio de teste/);
    db.close();
  });
});

describe('comandos do fluxo', () => {
  it('registra apply status, email preview-final e authorize --confirm', () => {
    const program = new Command();
    const never = (): never => {
      throw new Error('não deveria executar');
    };
    registerEmailCommands(program, { withDb: never, withDbAsync: never, parseId: Number });
    registerApplyCommands(program, { withDbAsync: never, parseId: Number });
    const email = program.commands.find((c) => c.name() === 'email');
    const names = email?.commands.map((c) => c.name()) ?? [];
    for (const name of ['preview-final', 'export-eml', 'authorize', 'send', 'dry-run', 'approve'])
      expect(names).toContain(name);
    const authorize = email?.commands.find((c) => c.name() === 'authorize');
    expect(authorize?.options.map((o) => o.long)).toContain('--confirm');
    const preview = email?.commands.find((c) => c.name() === 'preview-final');
    // Sem --json de propósito: o endereço completo e o corpo são só para o terminal.
    expect(preview?.options.map((o) => o.long)).toEqual(['--ancora-sha256']);
    const status = program.commands
      .find((c) => c.name() === 'apply')
      ?.commands.find((c) => c.name() === 'status');
    expect(status?.options.map((o) => o.long)).toEqual(['--job', '--ancora-sha256', '--json']);
  });
});
