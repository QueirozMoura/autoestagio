const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'ref',
  'ref_src',
  'referrer',
  'gh_src',
  'lever-source',
  'lever-origin',
  'trk',
  'trkinfo',
  'trackingid',
  'tracking_id',
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

export class InvalidJobUrlError extends Error {}

/**
 * URL canônica da vaga: HTTPS, host em minúsculas e sem "www.", sem fragmento, sem parâmetros de
 * rastreamento, parâmetros restantes ordenados e sem barras duplicadas ou finais.
 * Parâmetros que identificam a vaga (como `id=123`) são preservados.
 */
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch (error) {
    throw new InvalidJobUrlError(`URL inválida: ${raw}`, { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidJobUrlError(`A URL da vaga deve ser HTTP(S): ${raw}`);
  }

  const host = url.host.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');

  const kept = [...url.searchParams.entries()]
    .filter(([key]) => !isTrackingParam(key))
    .sort(([keyA, valueA], [keyB, valueB]) =>
      keyA === keyB ? valueA.localeCompare(valueB) : keyA.localeCompare(keyB),
    );
  const query = new URLSearchParams(kept).toString();

  return `https://${host}${path}${query === '' ? '' : `?${query}`}`;
}
