import { describe, expect, it } from 'vitest';
import {
  authenticateLato,
  FontTrustError,
  latoHashes,
  type LatoReference,
} from '../../src/cv/font-policy.js';
import { loadFonts } from '../../src/cv/index.js';
const refs = (): LatoReference[] => {
  const f = loadFonts();
  return [
    { name: 'Lato-Regular', bytes: Buffer.from(f.regular) },
    { name: 'Lato-Bold', bytes: Buffer.from(f.bold) },
  ];
};
describe('política de confiança fixada da Lato', () => {
  it('autentica ambas as variantes e não compartilha os buffers recebidos', () => {
    const input = refs();
    const out = authenticateLato(input);
    input[0]?.bytes.fill(0);
    input[1]?.bytes.fill(0);
    expect(
      authenticateLato([
        { name: 'Lato-Regular', bytes: out.regular },
        { name: 'Lato-Bold', bytes: out.bold },
      ]).regular.equals(out.regular),
    ).toBe(true);
  });
  it('alterar uma cópia do manifesto não muda os hashes confiáveis', () => {
    const hashes = latoHashes();
    hashes['Lato-Regular'] = '0'.repeat(64);
    expect(latoHashes()['Lato-Regular']).not.toBe(hashes['Lato-Regular']);
    expect(authenticateLato(refs()).bold.length).toBeGreaterThan(0);
  });
  it.each([
    'missing',
    'empty',
    'duplicate',
    'swapped',
    'tampered',
    'unknown',
    'huge',
    'nonbytes',
  ] as const)('recusa %s', (kind) => {
    const input = refs();
    if (kind === 'missing') input.pop();
    if (kind === 'empty') input.length = 0;
    if (kind === 'duplicate')
      input[1] = { name: 'Lato-Regular', bytes: input[0]?.bytes ?? new Uint8Array() };
    if (kind === 'swapped') {
      const a = input[0]?.bytes ?? new Uint8Array();
      input[0] = { name: 'Lato-Regular', bytes: input[1]?.bytes ?? new Uint8Array() };
      input[1] = { name: 'Lato-Bold', bytes: a };
    }
    if (kind === 'tampered') input[0]?.bytes.fill(7, 100, 101);
    if (kind === 'unknown')
      input[0] = { name: 'Lato-Italic' as LatoReference['name'], bytes: loadFonts().italic };
    if (kind === 'huge')
      input[0] = { name: 'Lato-Regular', bytes: Buffer.alloc(2 * 1024 * 1024 + 1) };
    if (kind === 'nonbytes')
      input[0] = { name: 'Lato-Regular', bytes: 'texto' as unknown as Uint8Array };
    expect(() => authenticateLato(input)).toThrow(FontTrustError);
  });
});
