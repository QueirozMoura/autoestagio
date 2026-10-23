import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Gravação exclusiva e privada de um arquivo já validado. Sem sobrescrita, sem `--force`, sem fallback.
 *
 * Garantias:
 *  - o diretório de saída é aberto UMA vez (O_DIRECTORY|O_NOFOLLOW) e toda operação seguinte passa por
 *    esse descritor (`/proc/self/fd/N/...`), então trocar o diretório por um link depois da abertura não
 *    redireciona a gravação;
 *  - temporário exclusivo (O_EXCL|O_NOFOLLOW, 0600), fsync, releitura e conferência do SHA-256 antes de publicar;
 *  - publicação por link(2) + unlink(2): atômica e nunca substitui um destino existente (nem corrida);
 *  - qualquer falha remove somente o temporário criado por esta chamada.
 *
 * Limites (não são protegidos):
 *  - Linux com /proc; em outras plataformas falha de forma fechada;
 *  - os ANCESTRAIS do diretório de saída são resolvidos por `realpath` antes da abertura: um atacante com
 *    permissão de escrita em um ancestral pode trocá-lo entre a resolução e a abertura. Uso seguro: diretório
 *    de saída cujos ancestrais pertençam ao usuário e não sejam graváveis por outros;
 *  - o diretório de saída precisa pertencer ao usuário e não ser gravável por grupo/outros;
 *  - "atômico" não é "durável": `durable` só é true se o fsync do arquivo e do diretório tiveram sucesso;
 *    depois da publicação nada lança: limpeza incompleta (`tempCleanup`) e `durable=false` são só informados;
 *  - sem suporte a hardlink no filesystem, a gravação é recusada (não há fallback para rename).
 */

const MESSAGES = {
  UNSUPPORTED_PLATFORM: 'Gravação segura indisponível nesta plataforma.',
  INVALID_INPUT: 'Entrada inválida para a gravação.',
  HASH_MISMATCH: 'Os bytes não correspondem ao SHA-256 esperado; nada foi gravado.',
  INVALID_NAME: 'Nome de arquivo inválido.',
  OUTPUT_DIR_INVALID: 'Diretório de saída inválido.',
  OUTPUT_DIR_UNSAFE: 'Diretório de saída inseguro (dono diferente ou gravável por outros).',
  SYMLINK_REJECTED: 'Link simbólico rejeitado no destino.',
  SPECIAL_FILE: 'O destino é um arquivo especial.',
  ALREADY_EXISTS: 'O arquivo de destino já existe; nada foi sobrescrito.',
  LINK_UNSUPPORTED: 'O filesystem não oferece a publicação atômica exigida (hardlink).',
  WRITE_FAILED: 'Falha ao gravar o arquivo temporário; nada foi publicado.',
  INTEGRITY_FAILED: 'A conferência de integridade do arquivo gravado falhou; nada foi publicado.',
  PUBLISH_FAILED: 'Falha ao publicar o arquivo; nada foi publicado.',
} as const;
export type SafeWriteErrorCode = keyof typeof MESSAGES;

/** Mensagem fixa: nunca inclui caminhos, nomes, hashes ou conteúdo. */
export class SafeWriteError extends Error {
  constructor(readonly code: SafeWriteErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SafeWriteError';
  }
}

/** Operações de filesystem usadas pelo módulo; existe para injetar falhas nos testes. */
export interface SafeWriteFs {
  openSync: typeof openSync;
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  linkSync: typeof linkSync;
  unlinkSync: typeof unlinkSync;
}
const realFs: SafeWriteFs = { openSync, writeSync, fsyncSync, linkSync, unlinkSync };

export interface SafeWriteOptions {
  /** Diretório de saída (absoluto ou relativo). Se o último nível não existir, é criado com 0700. */
  dir: string;
  /** Nome simples do arquivo (sem separadores). */
  name: string;
  /** Bytes já validados. */
  bytes: Uint8Array;
  /** SHA-256 esperado dos bytes (hex minúsculo). */
  sha256: string;
  /** Padrão true: cria somente o último nível do diretório, se o pai existir. */
  createDirectory?: boolean;
  /** Ponto de injeção para testes. */
  fs?: Partial<SafeWriteFs>;
}
export interface SafeWriteResult {
  /** Caminho final; só deve ser exibido depois do retorno com sucesso. */
  path: string;
  bytes: number;
  /**
   * Arquivo e diretório sincronizados em disco. `false` NÃO significa que o arquivo não existe: ele já
   * foi publicado, só não há confirmação de durabilidade após queda de energia.
   */
  durable: boolean;
  /** `left-behind`: o arquivo final está íntegro, mas sobrou um temporário (nome em `leftoverTemp`). */
  tempCleanup: 'removed' | 'left-behind';
  leftoverTemp?: string;
}

const HEX64 = /^[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return undefined;
    throw new SafeWriteError('OUTPUT_DIR_INVALID');
  }
}

/** Abre (e, se preciso, cria) o diretório de saída e devolve o descritor já validado. */
function openOutputDir(dir: string, create: boolean, io: SafeWriteFs): number {
  if (typeof dir !== 'string' || dir.length === 0 || dir.includes('\0'))
    throw new SafeWriteError('OUTPUT_DIR_INVALID');
  const lexical = resolve(dir);
  const parent = dirname(lexical);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    throw new SafeWriteError('OUTPUT_DIR_INVALID');
  }
  // Link simbólico em qualquer componente do caminho: o caminho real difere do léxico.
  if (realParent !== parent) throw new SafeWriteError('SYMLINK_REJECTED');
  const before = lstatOrUndefined(lexical);
  if (before?.isSymbolicLink() === true) throw new SafeWriteError('SYMLINK_REJECTED');
  if (before !== undefined && !before.isDirectory()) throw new SafeWriteError('OUTPUT_DIR_INVALID');
  let created = false;
  if (before === undefined) {
    if (!create) throw new SafeWriteError('OUTPUT_DIR_INVALID');
    try {
      mkdirSync(lexical, { mode: 0o700 });
      created = true;
    } catch (error) {
      // Outro processo pode ter criado o diretório entre o lstat e o mkdir: segue e valida abaixo.
      if (errnoOf(error) !== 'EEXIST') throw new SafeWriteError('OUTPUT_DIR_INVALID');
    }
  }
  let fd: number;
  try {
    fd = io.openSync(lexical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new SafeWriteError(
      errnoOf(error) === 'ELOOP' ? 'SYMLINK_REJECTED' : 'OUTPUT_DIR_INVALID',
    );
  }
  try {
    const stat = fstatSync(fd);
    const now = lstatOrUndefined(lexical);
    if (
      !stat.isDirectory() ||
      now === undefined ||
      now.isSymbolicLink() ||
      now.ino !== stat.ino ||
      now.dev !== stat.dev
    )
      throw new SafeWriteError('OUTPUT_DIR_INVALID');
    if (created) fchmodSync(fd, 0o700);
    const uid = process.getuid?.();
    if (uid === undefined || stat.uid !== uid || (stat.mode & 0o022) !== 0)
      throw new SafeWriteError('OUTPUT_DIR_UNSAFE');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function writeAll(fd: number, bytes: Uint8Array, io: SafeWriteFs): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error('escrita sem progresso');
    offset += written;
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = lstatSync(a);
    const y = lstatSync(b);
    return x.isFile() && y.isFile() && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

function verifyFile(path: string, expected: string, size: number): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size) return false;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, buffer, offset, size - offset, offset);
      if (read === 0) return false;
      offset += read;
    }
    return sha256(buffer) === expected;
  } finally {
    closeSync(fd);
  }
}

/** Grava `bytes` em `dir/name` sem nunca sobrescrever. Lança `SafeWriteError`. */
export function writePrivateExclusive(options: SafeWriteOptions): SafeWriteResult {
  const io: SafeWriteFs = { ...realFs, ...options.fs };
  if (process.platform !== 'linux') throw new SafeWriteError('UNSUPPORTED_PLATFORM');
  const { bytes, name } = options;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    typeof options.sha256 !== 'string' ||
    !HEX64.test(options.sha256)
  )
    throw new SafeWriteError('INVALID_INPUT');
  if (
    typeof name !== 'string' ||
    !NAME.test(name) ||
    name.includes('..') ||
    basename(name) !== name
  )
    throw new SafeWriteError('INVALID_NAME');
  // Os bytes são copiados e conferidos antes de qualquer E/S: o chamador não os altera durante a gravação.
  const data = Buffer.from(bytes);
  if (sha256(data) !== options.sha256) throw new SafeWriteError('HASH_MISMATCH');

  const dirFd = openOutputDir(options.dir, options.createDirectory !== false, io);
  const dirPath = resolve(options.dir);
  // Toda operação seguinte passa pelo descritor do diretório já validado.
  const base = `/proc/self/fd/${dirFd}`;
  const finalPath = `${base}/${name}`;
  const tempName = `.${name}.${randomBytes(8).toString('hex')}.tmp`;
  const tempPath = `${base}/${tempName}`;
  let tempCreated = false;
  let tempRemoved = false;
  let published = false;
  try {
    const existing = lstatOrUndefined(finalPath);
    if (existing !== undefined)
      throw new SafeWriteError(
        existing.isSymbolicLink()
          ? 'SYMLINK_REJECTED'
          : existing.isFile()
            ? 'ALREADY_EXISTS'
            : 'SPECIAL_FILE',
      );

    try {
      const fd = io.openSync(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      tempCreated = true;
      try {
        fchmodSync(fd, 0o600);
        writeAll(fd, data, io);
        io.fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      throw new SafeWriteError('WRITE_FAILED');
    }

    let intact: boolean;
    try {
      intact = verifyFile(tempPath, options.sha256, data.length);
    } catch {
      intact = false;
    }
    if (!intact) throw new SafeWriteError('INTEGRITY_FAILED');

    try {
      io.linkSync(tempPath, finalPath);
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === 'EEXIST') throw new SafeWriteError('ALREADY_EXISTS');
      // Erro ambíguo (ex.: EIO depois de o link ter sido criado): se o destino é o mesmo inode do
      // temporário, a publicação aconteceu e jamais pode ser reportada como falha.
      if (!sameFile(tempPath, finalPath))
        throw new SafeWriteError(
          errno !== undefined && LINK_UNSUPPORTED.has(errno)
            ? 'LINK_UNSUPPORTED'
            : 'PUBLISH_FAILED',
        );
    }
    published = true;
    // A partir daqui o destino é definitivo e completo: nada abaixo pode lançar nem desfazê-lo.
    for (let attempt = 0; attempt < 2 && !tempRemoved; attempt++) {
      try {
        io.unlinkSync(tempPath);
        tempRemoved = true;
      } catch {
        /* tenta mais uma vez; depois informa o resíduo */
      }
    }
    // O fsync do arquivo já ocorreu antes da publicação; aqui falta o do diretório.
    let durable: boolean;
    try {
      io.fsyncSync(dirFd);
      durable = true;
    } catch {
      durable = false;
    }
    return {
      path: `${dirPath}/${name}`,
      bytes: data.length,
      durable,
      tempCleanup: tempRemoved ? 'removed' : 'left-behind',
      ...(tempRemoved ? {} : { leftoverTemp: tempName }),
    };
  } finally {
    // Remove somente o temporário criado por esta chamada; nunca o destino de outra operação.
    if (tempCreated && !published) {
      try {
        io.unlinkSync(tempPath);
      } catch {
        /* temporário já removido */
      }
    }
    try {
      closeSync(dirFd);
    } catch {
      /* o arquivo já foi publicado (ou a operação já falhou): fechar não muda o resultado */
    }
  }
}
