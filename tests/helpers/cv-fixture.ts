import {
  enrichModel,
  extractPdfBytes,
  parseMaster,
  type CvMaster,
  type PdfExtraction,
} from '../../src/cv/index.js';
import { makeFictionalMasterPdf, type FictionalOptions } from './master-pdf.js';

export interface Loaded {
  bytes: Buffer;
  extraction: PdfExtraction;
  model: CvMaster;
  enriched: CvMaster;
}

/** Modelo mestre FICTÍCIO pronto para os testes (nenhum dado real). */
export async function loadFictional(options: FictionalOptions = {}): Promise<Loaded> {
  const bytes = await makeFictionalMasterPdf(options);
  const extraction = await extractPdfBytes(bytes, 'mestre-ficticio.pdf');
  const { model } = parseMaster(extraction, { now: new Date('2026-10-22T12:00:00Z') });
  return { bytes, extraction, model, enriched: enrichModel(model) };
}
