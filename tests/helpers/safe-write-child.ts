import { createHash } from 'node:crypto';
import { writePrivateExclusive, SafeWriteError } from '../../src/utils/safe-write.js';

const [dir = '', name = '', index = '0'] = process.argv.slice(2);
const bytes = Buffer.from(`conteudo-sintetico-${index}`.repeat(4096));
try {
  writePrivateExclusive({
    dir,
    name,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  process.stdout.write('ok');
} catch (error) {
  process.stdout.write(error instanceof SafeWriteError ? error.code : 'erro');
  process.exitCode = 3;
}
