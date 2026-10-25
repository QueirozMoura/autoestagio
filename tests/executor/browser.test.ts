import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightPage, findBrowser } from '../../src/executor/index.js';
import { classifyPage } from '../../src/executor/detect.js';
import { planForm } from '../../src/executor/plan.js';
import { applicant } from './fixtures.js';

/**
 * Teste com um Chromium REAL, sem rede: o HTML é injetado na página (setContent). Pula sozinho se não houver navegador.
 * Confere que os scripts de leitura entendem rótulos, grupos de opções e campos escondidos, e que preencher, selecionar e
 * anexar realmente mudam a página. Nenhum clique, nenhum envio.
 */
let browser: Browser | undefined;
let dir: string;
let executable: string | undefined;
try {
  executable = findBrowser();
} catch {
  executable = undefined;
}

const HTML = `<html><head><title>Candidatura</title></head><body>
<h1>Estágio em Dados</h1>
<form onsubmit="return false">
  <label for="first_name">Primeiro nome *</label><input id="first_name" name="first_name" required>
  <label for="last_name">Sobrenome *</label><input id="last_name" name="last_name" required>
  <label for="email">E-mail *</label><input id="email" name="email" type="email" required>
  <label>Celular * <input name="phone" type="tel" required></label>
  <input aria-label="LinkedIn" name="linkedin">
  <label for="resume">Currículo *</label><input id="resume" name="resume" type="file" required style="display:none">
  <label for="pais">País *</label><select id="pais" name="pais" required><option>Selecione</option><option>Argentina</option><option>Brasil</option></select>
  <label for="sal">Pretensão salarial *</label><input id="sal" name="sal" required>
  <fieldset><legend>Você tem disponibilidade para trabalhar presencialmente? *</legend>
    <label><input type="radio" name="pres" value="s"> Sim</label><label><input type="radio" name="pres" value="n"> Não</label></fieldset>
  <fieldset><legend>Autodeclaração voluntária</legend>
  <label for="gen">Gênero</label><select id="gen" name="gen"><option>Selecione</option><option>Feminino</option></select></fieldset>
  <label><input type="checkbox" name="lgpd"> Li e aceito a política de privacidade *</label>
  <textarea name="g-recaptcha-response" style="display:none"></textarea>
  <input name="honeypot" style="display:none">
  <button type="submit">Enviar candidatura</button>
</form></body></html>`;

describe.skipIf(executable === undefined)('executor com navegador real (HTML local)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'br-'));
    browser = await chromium.launch({ executablePath: executable as string, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lê rótulos, grupos e campos escondidos e ignora CAPTCHA/honeypot', async () => {
    const page = new PlaywrightPage(await (browser as Browser).newPage());
    await (page as unknown as { page: { setContent(h: string): Promise<void> } }).page.setContent(
      HTML,
    );
    const form = await page.extractForm();
    const labels = form.fields.map((f) => `${f.kind}:${f.label}${f.required ? '*' : ''}`);
    expect(labels).toEqual([
      'text:Primeiro nome*',
      'text:Sobrenome*',
      'email:E-mail*',
      'tel:Celular*',
      'text:LinkedIn',
      'file:Currículo*',
      'select:País*',
      'text:Pretensão salarial*',
      'radio:Você tem disponibilidade para trabalhar presencialmente?*',
      'select:Gênero',
      'checkbox:Li e aceito a política de privacidade*',
    ]);
    expect(form.fields.find((f) => f.kind === 'radio')?.options).toHaveLength(2);
    expect(form.fields.find((f) => f.label === 'País')?.options).toEqual(['Argentina', 'Brasil']);
    expect(form.fields.find((f) => f.label === 'Gênero')?.section).toBe(
      'Autodeclaração voluntária',
    );
    const signals = await page.signals();
    expect(signals.submitLabels).toEqual(['Enviar candidatura']);
    expect(signals.hasPasswordInput).toBe(false);
    expect(classifyPage(signals, form).kind).toBe('ok');
    await page.close();
  });

  it('preenche, seleciona e anexa de verdade e deixa para você o que é seu', async () => {
    const pdf = join(dir, 'cv.pdf');
    writeFileSync(pdf, '%PDF-1.4\n% ficticio\n');
    const page = new PlaywrightPage(await (browser as Browser).newPage());
    await (page as unknown as { page: { setContent(h: string): Promise<void> } }).page.setContent(
      HTML,
    );
    const form = await page.extractForm();
    const plan = planForm(form, { applicant, salary: 1800, cv: { path: pdf, label: 'cv.pdf' } });
    for (const action of plan.actions) {
      const field = form.fields.find((f) => f.id === action.fieldId);
      if (field === undefined) continue;
      const read =
        action.op === 'upload'
          ? await page.upload(field.selector, action.value)
          : action.op === 'select'
            ? await page.select(field.selector, action.value)
            : await page.fill(field.selector, action.value);
      expect(read).not.toBe('');
    }
    const byLabel = (label: string) => form.fields.find((f) => f.label === label)?.selector ?? '';
    expect(await page.fill(byLabel('Sobrenome'), 'Exemplo da Silva')).toBe('Exemplo da Silva');
    expect(plan.actions.map((a) => a.label)).toEqual([
      'Primeiro nome',
      'Sobrenome',
      'E-mail',
      'Celular',
      'LinkedIn',
      'Currículo',
      'País',
      'Pretensão salarial',
    ]);
    expect(plan.needsHuman.map((h) => h.category)).toEqual([
      'confirmacao',
      'sensivel',
      'consentimento',
    ]);
    expect(await page.select(byLabel('País'), 'Brasil')).toBe('Brasil');
    expect(await page.upload(byLabel('Currículo'), pdf)).toBe('cv.pdf');
    await page.close();
  });
});
