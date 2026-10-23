import PDFDocument from 'pdfkit';

/**
 * Ferramentas de teste para ADULTERAR ou MONTAR PDFs em memória (nenhum arquivo). Toda troca preserva o
 * tamanho em bytes, para a tabela de referências continuar válida.
 */
export function tamperSameLength(bytes: Buffer, from: string, to: string, occurrence = 0): Buffer {
  if (from.length !== to.length)
    throw new Error(`troca de tamanho diferente (${from.length} × ${to.length}): "${from}"`);
  const raw = bytes.toString('latin1');
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = raw.indexOf(from, at + 1);
    if (at < 0) throw new Error(`trecho não encontrado: "${from}"`);
  }
  return Buffer.from(`${raw.slice(0, at)}${to}${raw.slice(at + from.length)}`, 'latin1');
}

/** Troca o valor ASCII (string literal) de uma chave do dicionário Info, mantendo o tamanho. */
export function tamperInfo(bytes: Buffer, key: string, value: string): Buffer {
  const raw = bytes.toString('latin1');
  const ref = new RegExp(`/${key} (\\d+) 0 R`).exec(raw);
  if (ref === null) throw new Error(`Info sem /${key}`);
  const object = new RegExp(`\\n${ref[1]} 0 obj\\n\\(([^)]*)\\)`).exec(raw);
  if (object === null) throw new Error(`/${key} não é uma string ASCII simples`);
  return tamperSameLength(
    bytes,
    `\n${ref[1]} 0 obj\n(${object[1]})`,
    `\n${ref[1]} 0 obj\n(${value})`,
  );
}

/** PDF montado à mão (Helvetica padrão), para casos que o renderizador nunca produz. */
export function craftPdf(
  draw: (pdf: PDFKit.PDFDocument) => void,
  size: [number, number] | 'A4' = 'A4',
): Promise<Buffer> {
  const pdf = new PDFDocument({
    size,
    margins: { top: 40, bottom: 0, left: 46, right: 46 },
    info: { CreationDate: new Date('2026-01-01T00:00:00Z') },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
  draw(pdf);
  pdf.end();
  return done;
}

/** Monta um PDF mínimo e VÁLIDO (tabela de referências correta) a partir dos corpos dos objetos 1..n. */
export function buildPdf(
  bodies: (string | Buffer)[],
  options: { trailerExtra?: string; afterEof?: string; startxrefDelta?: number } = {},
): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]?.length ?? 0;
  bodies.forEach((body, i) => {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(part);
    length += part.length;
  });
  const xrefAt = length;
  const table = [
    `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R ${options.trailerExtra ?? ''} >>\n`,
    `startxref\n${xrefAt + (options.startxrefDelta ?? 0)}\n%%EOF\n${options.afterEof ?? ''}`,
  ].join('');
  parts.push(Buffer.from(table, 'latin1'));
  return Buffer.concat(parts);
}
