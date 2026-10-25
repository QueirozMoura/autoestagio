import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { EXTRACT_FORM_SCRIPT, SIGNALS_SCRIPT } from './extract.js';
import { ExecutorError, assertSafeUrl, type BrowserSession, type PageDriver } from './driver.js';
import type { FormModel, PageSignals } from './types.js';

const COMMON = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/** Chrome/Chromium: variável AUTOESTAGIO_BROWSER, depois o PATH e, por fim, o cache do Playwright. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.AUTOESTAGIO_BROWSER;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!existsSync(fromEnv))
      throw new ExecutorError('AUTOESTAGIO_BROWSER aponta para um arquivo que não existe.');
    return fromEnv;
  }
  for (const dir of (env.PATH ?? '').split(':'))
    for (const name of COMMON) {
      const candidate = join(dir, name);
      if (dir !== '' && existsSync(candidate)) return candidate;
    }
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      const exe = join(cache, build, 'chrome-linux64', 'chrome');
      if (existsSync(exe) && statSync(exe).isFile()) return exe;
    }
  }
  throw new ExecutorError(
    'Nenhum Chrome/Chromium encontrado. Instale um ou defina AUTOESTAGIO_BROWSER com o caminho do executável.',
  );
}

/** Só o que lemos do DOM (o projeto não carrega os tipos do navegador). */
interface SelectLike {
  selectedOptions: ArrayLike<{ textContent: string | null }>;
}
interface NodeLike {
  parentElement: NodeLike | null;
  textContent: string | null;
}
interface FilesLike {
  files?: ArrayLike<{ name: string }> | null;
}

export class PlaywrightPage implements PageDriver {
  constructor(private readonly page: Page) {}

  async goto(url: string): Promise<void> {
    assertSafeUrl(url);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await this.page.waitForTimeout(1_500);
  }

  async signals(): Promise<PageSignals> {
    return await this.page.evaluate<PageSignals>(SIGNALS_SCRIPT);
  }

  async extractForm(): Promise<FormModel> {
    return await this.page.evaluate<FormModel>(EXTRACT_FORM_SCRIPT);
  }

  async fill(selector: string, value: string): Promise<string> {
    const field = this.page.locator(selector).first();
    await field.fill(value, { timeout: 10_000 });
    let read = await field.inputValue({ timeout: 5_000 });
    // Campos com máscara: se o valor não ficou, digita como uma pessoa digitaria.
    if (read.replace(/\D/g, '') !== value.replace(/\D/g, '') && /\d/.test(value)) {
      await field.fill('');
      await field.pressSequentially(value, { delay: 25 });
      read = await field.inputValue({ timeout: 5_000 });
    }
    return read;
  }

  async select(selector: string, optionLabel: string): Promise<string> {
    const field = this.page.locator(selector).first();
    await field.selectOption({ label: optionLabel }, { timeout: 10_000 });
    return field.evaluate((el) => {
      const select = el as unknown as SelectLike;
      return select.selectedOptions[0]?.textContent?.trim() ?? '';
    });
  }

  async choose(selector: string, optionLabel: string): Promise<string> {
    const field = this.page.locator(selector).first();
    await field.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await field.click({ timeout: 5_000 });
    // Só uma opção da lista: nunca um botão do formulário.
    const option = this.page
      .locator('li, [role=option]')
      .filter({
        hasText: new RegExp(`^\\s*${optionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`),
      })
      .first();
    await option.click({ timeout: 5_000 });
    await this.page.waitForTimeout(400);
    const typed = await field.inputValue({ timeout: 3_000 }).catch(() => '');
    if (typed !== '') return typed;
    // Listas que mostram a escolha fora do <input> (ex.: react-select): lê o valor exibido no próprio componente.
    return field
      .evaluate((el, label) => {
        let node = (el as unknown as NodeLike).parentElement;
        for (let i = 0; i < 4 && node; i += 1, node = node.parentElement) {
          const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text.includes(label) && text.length < 200) return label;
        }
        return '';
      }, optionLabel)
      .catch(() => '');
  }

  async upload(selector: string, filePath: string): Promise<string> {
    const field = this.page.locator(selector).first();
    await field.setInputFiles(filePath, { timeout: 20_000 });
    await this.page.waitForTimeout(1_000);
    // Alguns formulários trocam o <input> depois do anexo: se ele sumiu, confere pelo nome mostrado na página.
    const name = await field
      .evaluate((el) => {
        const input = el as unknown as FilesLike;
        return input.files?.[0]?.name ?? '';
      })
      .catch(() => '');
    if (name !== '') return name;
    const shown = await this.page
      .getByText(basename(filePath), { exact: false })
      .first()
      .isVisible({ timeout: 4_000 })
      .catch(() => false);
    return shown ? basename(filePath) : '';
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  async text(): Promise<string> {
    return await this.page.evaluate<string>('(document.body.innerText || "").slice(0, 8000)');
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }
}

export interface LaunchOptions {
  profileDir: string;
  headless: boolean;
  executablePath?: string;
  allowedDocumentHosts?: readonly string[];
}

/**
 * Sessão real do Chrome com perfil PRÓPRIO do AutoEstágio (data/browser-profile): você pode entrar uma vez na sua conta
 * (ex.: Gupy) no modo com janela e o login fica guardado ali, sem senha em texto puro no projeto. Não esconde que é um
 * navegador automatizado e não tenta enganar nenhuma proteção.
 */
export async function launchSession(options: LaunchOptions): Promise<BrowserSession> {
  const context: BrowserContext = await chromium.launchPersistentContext(options.profileDir, {
    executablePath: options.executablePath ?? findBrowser(),
    headless: options.headless,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
    serviceWorkers: 'block',
  });
  // Também bloqueia redirects, iframes e subrecursos antes da requisição ao host restrito.
  await context.route('**/*', async (route) => {
    try {
      if (/^https?:/.test(route.request().url())) assertSafeUrl(route.request().url());
      if (
        route.request().isNavigationRequest() &&
        options.allowedDocumentHosts !== undefined &&
        !options.allowedDocumentHosts.includes(new URL(route.request().url()).hostname)
      )
        throw new ExecutorError('Navegação para host sem revisão de preparo agendado.');
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  return {
    newPage: async () => new PlaywrightPage(await context.newPage()),
    close: async () => {
      await context.close().catch(() => undefined);
    },
    waitUntilClosed: (timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
        context.on('close', () => {
          clearTimeout(timer);
          resolve(true);
        });
      }),
  };
}
