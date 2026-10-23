import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync as realLink,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SafeWriteError,
  writePrivateExclusive,
  type SafeWriteErrorCode,
  type SafeWriteFs,
  type SafeWriteOptions,
} from '../../src/utils/safe-write.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';

vi.setConfig({ testTimeout: 30_000 });
const run = promisify(execFile);
const bytes = Buffer.from('conteudo sintetico do arquivo validado');
const hash = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'safewrite-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const args = (over: Partial<SafeWriteOptions> = {}): SafeWriteOptions => ({
  dir: join(root, 'saida'),
  name: 'curriculo-teste.pdf',
  bytes,
  sha256: hash(bytes),
  ...over,
});
const codeOf = (fn: () => unknown): SafeWriteErrorCode => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SafeWriteError) return error.code;
    throw error;
  }
  throw new Error('não falhou');
};
const mode = (path: string): number => statSync(path).mode & 0o777;
const files = (dir: string): string[] => readdirSync(dir).sort();
const enoent = (code: string): Error => Object.assign(new Error('falha injetada'), { code });

describe('gravação segura exclusiva', () => {
  it('grava com 0600, cria o diretório com 0700 e não deixa temporários', () => {
    const result = writePrivateExclusive(args());
    const dir = join(root, 'saida');
    expect(result).toEqual({
      path: join(dir, 'curriculo-teste.pdf'),
      bytes: bytes.length,
      durable: true,
      tempCleanup: 'removed',
    });
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
    expect(mode(result.path)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(files(dir)).toEqual(['curriculo-teste.pdf']);
  });

  it('não altera as permissões de um diretório que já existia', () => {
    const dir = join(root, 'saida');
    mkdirSync(dir, { mode: 0o750 });
    chmodSync(dir, 0o750);
    writePrivateExclusive(args());
    expect(mode(dir)).toBe(0o750);
  });

  it('recusa diretório existente gravável por outros', () => {
    const dir = join(root, 'saida');
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    expect(codeOf(() => writePrivateExclusive(args()))).toBe('OUTPUT_DIR_UNSAFE');
    expect(files(dir)).toEqual([]);
  });

  it('nunca sobrescreve um arquivo existente', () => {
    const dir = join(root, 'saida');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'curriculo-teste.pdf'), 'original');
    expect(codeOf(() => writePrivateExclusive(args()))).toBe('ALREADY_EXISTS');
    expect(readFileSync(join(dir, 'curriculo-teste.pdf'), 'utf8')).toBe('original');
    expect(files(dir)).toEqual(['curriculo-teste.pdf']);
  });

  it('perde a corrida de forma segura quando outro escritor publica primeiro', () => {
    const dir = join(root, 'saida');
    const fs: Partial<SafeWriteFs> = {
      linkSync: (existing, target) => {
        writeFileSync(join(dir, 'curriculo-teste.pdf'), 'do outro escritor');
        realLink(existing, target);
      },
    };
    expect(codeOf(() => writePrivateExclusive(args({ fs })))).toBe('ALREADY_EXISTS');
    expect(readFileSync(join(dir, 'curriculo-teste.pdf'), 'utf8')).toBe('do outro escritor');
    expect(files(dir)).toEqual(['curriculo-teste.pdf']);
  });

  it('um symlink criado na janela da corrida não redireciona a gravação', () => {
    const dir = join(root, 'saida');
    const outside = join(root, 'fora.pdf');
    const fs: Partial<SafeWriteFs> = {
      linkSync: (existing, target) => {
        symlinkSync(outside, join(dir, 'curriculo-teste.pdf'));
        realLink(existing, target);
      },
    };
    expect(codeOf(() => writePrivateExclusive(args({ fs })))).toBe('ALREADY_EXISTS');
    expect(existsSync(outside)).toBe(false);
  });

  it('com processos concorrentes exatamente um vence e o resultado é íntegro', async () => {
    const dir = join(root, 'saida');
    mkdirSync(dir, { mode: 0o700 });
    const tsx = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
    const child = join(PROJECT_ROOT, 'tests', 'helpers', 'safe-write-child.ts');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(tsx, [child, dir, 'disputado.pdf', String(i)]).then(
          (r) => r.stdout,
          (e: unknown) => (e as { stdout: string }).stdout,
        ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'ALREADY_EXISTS')).toHaveLength(7);
    expect(files(dir)).toEqual(['disputado.pdf']);
    const content = readFileSync(join(dir, 'disputado.pdf'));
    const winner = Number(
      /conteudo-sintetico-(\d)/u.exec(content.toString('utf8').slice(0, 30))?.[1],
    );
    expect(content.equals(Buffer.from(`conteudo-sintetico-${winner}`.repeat(4096)))).toBe(true);
    expect(mode(join(dir, 'disputado.pdf'))).toBe(0o600);
  });

  it.each(['alvo existente', 'alvo inexistente'])('rejeita symlink no destino (%s)', (kind) => {
    const dir = join(root, 'saida');
    mkdirSync(dir, { mode: 0o700 });
    const outside = join(root, 'fora.pdf');
    if (kind === 'alvo existente') writeFileSync(outside, 'intacto');
    symlinkSync(outside, join(dir, 'curriculo-teste.pdf'));
    expect(codeOf(() => writePrivateExclusive(args()))).toBe('SYMLINK_REJECTED');
    expect(existsSync(outside) ? readFileSync(outside, 'utf8') : null).toBe(
      kind === 'alvo existente' ? 'intacto' : null,
    );
  });

  it('rejeita symlink no diretório de saída e em componentes do caminho', () => {
    const real = join(root, 'real');
    mkdirSync(join(real, 'saida'), { recursive: true, mode: 0o700 });
    symlinkSync(real, join(root, 'atalho'));
    expect(codeOf(() => writePrivateExclusive(args({ dir: join(root, 'atalho', 'saida') })))).toBe(
      'SYMLINK_REJECTED',
    );
    symlinkSync(join(real, 'saida'), join(root, 'saida'));
    expect(codeOf(() => writePrivateExclusive(args()))).toBe('SYMLINK_REJECTED');
    expect(files(join(real, 'saida'))).toEqual([]);
  });

  it('trocar o diretório por um symlink depois da abertura não redireciona a gravação', () => {
    const dir = join(root, 'saida');
    const moved = join(root, 'movido');
    const attacker = join(root, 'atacante');
    mkdirSync(attacker, { mode: 0o700 });
    let swapped = false;
    const fs: Partial<SafeWriteFs> = {
      openSync: ((path: string, flags: number, fileMode?: number) => {
        if (!swapped && path.endsWith('.tmp')) {
          swapped = true;
          renameSync(dir, moved);
          symlinkSync(attacker, dir);
        }
        return openSync(path, flags, fileMode);
      }) as SafeWriteFs['openSync'],
    };
    writePrivateExclusive(args({ fs }));
    expect(swapped).toBe(true);
    expect(files(moved)).toEqual(['curriculo-teste.pdf']);
    expect(files(attacker)).toEqual([]);
  });

  it('rejeita diretórios de saída inválidos', () => {
    writeFileSync(join(root, 'arquivo'), 'x');
    execFileSync('mkfifo', [join(root, 'fila')]);
    for (const dir of [
      '',
      join(root, 'arquivo'),
      join(root, 'fila'),
      join(root, 'nao', 'existe', 'saida'),
    ])
      expect(codeOf(() => writePrivateExclusive(args({ dir })))).toBe('OUTPUT_DIR_INVALID');
    expect(
      codeOf(() =>
        writePrivateExclusive(args({ dir: join(root, 'ausente'), createDirectory: false })),
      ),
    ).toBe('OUTPUT_DIR_INVALID');
    expect(existsSync(join(root, 'ausente'))).toBe(false);
  });

  it('rejeita arquivo especial no destino', () => {
    const dir = join(root, 'saida');
    mkdirSync(dir, { mode: 0o700 });
    execFileSync('mkfifo', [join(dir, 'curriculo-teste.pdf')]);
    expect(codeOf(() => writePrivateExclusive(args()))).toBe('SPECIAL_FILE');
    expect(files(dir)).toEqual(['curriculo-teste.pdf']);
  });

  it.each(['../fora.pdf', 'a/b.pdf', '', '.oculto', 'x'.repeat(200), 'a..b', 'nome\0.pdf'])(
    'rejeita nome inválido %j',
    (name) => {
      expect(codeOf(() => writePrivateExclusive(args({ name })))).toBe('INVALID_NAME');
      expect(existsSync(join(root, 'saida'))).toBe(false);
    },
  );

  it('rejeita hash divergente ou malformado sem tocar o disco', () => {
    expect(codeOf(() => writePrivateExclusive(args({ sha256: hash(Buffer.from('outro')) })))).toBe(
      'HASH_MISMATCH',
    );
    expect(codeOf(() => writePrivateExclusive(args({ sha256: 'ABC' })))).toBe('INVALID_INPUT');
    expect(codeOf(() => writePrivateExclusive(args({ bytes: Buffer.alloc(0) })))).toBe(
      'INVALID_INPUT',
    );
    expect(existsSync(join(root, 'saida'))).toBe(false);
  });

  it('aceita escritas parciais do sistema', () => {
    const fs: Partial<SafeWriteFs> = {
      writeSync: ((fd: number, buffer: Uint8Array, offset: number, length: number) =>
        writeSync(fd, buffer, offset, Math.min(length, 3))) as SafeWriteFs['writeSync'],
    };
    const result = writePrivateExclusive(args({ fs }));
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
  });

  it('falha na escrita: nada é publicado e o temporário é removido', () => {
    const dir = join(root, 'saida');
    const fs: Partial<SafeWriteFs> = {
      writeSync: ((fd: number, buffer: Uint8Array, offset: number) => {
        writeSync(fd, buffer, offset, 5); // escrita parcial já no disco
        throw enoent('ENOSPC');
      }) as unknown as SafeWriteFs['writeSync'],
    };
    expect(codeOf(() => writePrivateExclusive(args({ fs })))).toBe('WRITE_FAILED');
    expect(files(dir)).toEqual([]);
  });

  it('falha no fsync: nada é publicado', () => {
    const fs: Partial<SafeWriteFs> = {
      fsyncSync: () => {
        throw enoent('EIO');
      },
    };
    expect(codeOf(() => writePrivateExclusive(args({ fs })))).toBe('WRITE_FAILED');
    expect(files(join(root, 'saida'))).toEqual([]);
  });

  it('bytes gravados diferentes dos esperados: não publica', () => {
    const fs: Partial<SafeWriteFs> = {
      writeSync: ((fd: number, _b: Uint8Array, _o: number, length: number) =>
        writeSync(fd, Buffer.alloc(length, 0x41), 0, length)) as SafeWriteFs['writeSync'],
    };
    expect(codeOf(() => writePrivateExclusive(args({ fs })))).toBe('INTEGRITY_FAILED');
    expect(files(join(root, 'saida'))).toEqual([]);
  });

  it('falha na publicação: nada fica com aparência de concluído', () => {
    const fs: Partial<SafeWriteFs> = {
      linkSync: () => {
        throw enoent('EIO');
      },
    };
    expect(codeOf(() => writePrivateExclusive(args({ fs })))).toBe('PUBLISH_FAILED');
    expect(files(join(root, 'saida'))).toEqual([]);
  });

  it.each(['EPERM', 'ENOTSUP', 'EXDEV'])(
    'filesystem sem hardlink (%s): falha fechada, sem rename como fallback',
    (errno) => {
      const fs: Partial<SafeWriteFs> = {
        linkSync: () => {
          throw enoent(errno);
        },
      };
      expect(codeOf(() => writePrivateExclusive(args({ fs })))).toBe('LINK_UNSUPPORTED');
      expect(files(join(root, 'saida'))).toEqual([]);
    },
  );

  it('se só a limpeza do temporário falha, o destino íntegro existe e o resíduo é informado', () => {
    const dir = join(root, 'saida');
    const fs: Partial<SafeWriteFs> = {
      unlinkSync: () => {
        throw enoent('EIO');
      },
    };
    const result = writePrivateExclusive(args({ fs }));
    expect(result.tempCleanup).toBe('left-behind');
    expect(result.durable).toBe(true);
    const leftover = files(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftover).toEqual([result.leftoverTemp]);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
  });

  it('se só o fsync do diretório falha, o arquivo está publicado e durable é false', () => {
    const dir = join(root, 'saida');
    let calls = 0;
    const fs: Partial<SafeWriteFs> = {
      fsyncSync: (fd) => {
        // 1ª chamada: arquivo temporário; 2ª: diretório.
        if (++calls === 2) throw enoent('EIO');
        fsyncSync(fd);
      },
    };
    const result = writePrivateExclusive(args({ fs }));
    expect(result).toMatchObject({ durable: false, tempCleanup: 'removed' });
    expect(files(dir)).toEqual(['curriculo-teste.pdf']);
  });

  it('erro ambíguo no link com o arquivo já publicado conta como publicação, não como falha', () => {
    const dir = join(root, 'saida');
    const fs: Partial<SafeWriteFs> = {
      linkSync: (existing, target) => {
        realLink(existing, target);
        throw enoent('EIO');
      },
    };
    const result = writePrivateExclusive(args({ fs }));
    expect(result.tempCleanup).toBe('removed');
    expect(files(dir)).toEqual(['curriculo-teste.pdf']);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
  });

  it('falha ao fechar o diretório depois de publicar não mascara o sucesso', () => {
    expect(writePrivateExclusive(args()).durable).toBe(true);
  });

  it('os erros não vazam caminho, nome, hash nem conteúdo', () => {
    const dir = join(root, 'saida');
    const cases: Partial<SafeWriteOptions>[] = [
      { sha256: hash(Buffer.from('outro')) },
      { name: '../x' },
      {
        fs: {
          linkSync: () => {
            throw enoent('EPERM');
          },
        },
      },
      {
        fs: {
          writeSync: () => {
            throw enoent('ENOSPC');
          },
        },
      },
    ];
    for (const over of cases) {
      try {
        writePrivateExclusive(args(over));
        throw new Error('não falhou');
      } catch (error) {
        expect(error).toBeInstanceOf(SafeWriteError);
        const text =
          `${(error as Error).message} ${(error as Error).stack ?? ''}`.split('\n')[0] ?? '';
        for (const secret of [root, dir, 'curriculo-teste', hash(bytes), 'sintetico'])
          expect(text).not.toContain(secret);
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });
});
