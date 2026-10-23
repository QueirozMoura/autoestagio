import { createHash } from 'node:crypto';

export interface LatoReference {
  name: 'Lato-Regular' | 'Lato-Bold';
  bytes: Uint8Array;
}

// Âncora versionada: nunca recebida do chamador, de arquivos de configuração ou do ambiente.
const REGULAR = '6f6940be0835c3ddec9199e5fc42be4cbc61ebcfd58c623fdf719366253f1780';
const BOLD = 'bf1b8130069b44b9148eeece35e5423bedac49777ba746615b826b8276574a7b';

export class FontTrustError extends Error {
  constructor() {
    super(
      'Referências Lato ausentes, repetidas, inválidas ou incompatíveis com a política fixada.',
    );
    this.name = 'FontTrustError';
  }
}

export const fontSha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const latoHashes = (): Record<LatoReference['name'], string> => ({
  'Lato-Regular': REGULAR,
  'Lato-Bold': BOLD,
});

/** Autentica cópias privadas dos bytes. Nenhum objeto preparado ou booleano do chamador prova confiança. */
export function authenticateLato(inputs: readonly LatoReference[]): {
  regular: Buffer;
  bold: Buffer;
} {
  if (!Array.isArray(inputs) || inputs.length !== 2) throw new FontTrustError();
  const copies = new Map<string, Buffer>();
  for (const value of inputs as readonly unknown[]) {
    if (value === null || typeof value !== 'object') throw new FontTrustError();
    const input = value as Partial<LatoReference>;
    if (
      (input.name !== 'Lato-Regular' && input.name !== 'Lato-Bold') ||
      !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength > 2 * 1024 * 1024 ||
      copies.has(input.name)
    )
      throw new FontTrustError();
    const copy = Buffer.from(input.bytes);
    const expected = input.name === 'Lato-Regular' ? REGULAR : BOLD;
    if (fontSha256(copy) !== expected) throw new FontTrustError();
    copies.set(input.name, copy);
  }
  const regular = copies.get('Lato-Regular');
  const bold = copies.get('Lato-Bold');
  if (regular === undefined || bold === undefined) throw new FontTrustError();
  return { regular, bold };
}
