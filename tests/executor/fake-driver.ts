import type { BrowserSession, PageDriver } from '../../src/executor/driver.js';
import type { FormModel, PageSignals } from '../../src/executor/types.js';

export interface FakePage {
  signals: PageSignals;
  /** Uma lista = cada releitura do formulário devolve o próximo (campos dinâmicos); a última se repete. */
  form: FormModel | FormModel[] | null;
  /** Texto depois que "você" envia (para a evidência). */
  afterText?: string;
  failOn?: 'goto' | 'fill';
  /** Máscara nacional: lê o prefixo +55 como DDD e devolve algo diferente do esperado. */
  nationalPhoneMask?: boolean;
  selectReadBack?: string;
}

/** Navegador simulado: registra cada operação e NUNCA envia nada (a interface nem tem essa operação). */
export class FakeSession implements BrowserSession {
  readonly calls: string[] = [];
  readonly values = new Map<string, string>();
  private text = '';
  closed = false;
  constructor(private readonly pages: Record<string, FakePage>) {}

  newPage(): Promise<PageDriver> {
    const calls = this.calls;
    const values = this.values;
    let current: FakePage | undefined;
    let reads = 0;
    const page = {
      goto: (url: string) => {
        calls.push(`goto ${url}`);
        current = this.pages[url];
        if (current === undefined) throw new Error('página inexistente');
        if (current.failOn === 'goto') throw new Error('timeout');
        this.text = current.signals.text;
        return Promise.resolve();
      },
      signals: () => Promise.resolve((current as FakePage).signals),
      extractForm: () => {
        calls.push('extractForm');
        const forms = (current as FakePage).form;
        const model = Array.isArray(forms)
          ? (forms[Math.min(reads++, forms.length - 1)] as FormModel)
          : forms;
        return Promise.resolve(model as FormModel);
      },
      fill: (selector: string, value: string) => {
        calls.push(`fill ${selector}`);
        if (current?.failOn === 'fill') throw new Error('falha');
        if (current?.nationalPhoneMask === true && value.startsWith('+55'))
          return Promise.resolve('(55) 119999999');
        values.set(selector, value);
        return Promise.resolve(value);
      },
      select: (selector: string, option: string) => {
        calls.push(`select ${selector}`);
        values.set(selector, option);
        return Promise.resolve(current?.selectReadBack ?? option);
      },
      choose: (selector: string, option: string) => {
        calls.push(`choose ${selector}`);
        values.set(selector, option);
        return Promise.resolve(option);
      },
      upload: (selector: string, path: string) => {
        calls.push(`upload ${selector}`);
        values.set(selector, path);
        return Promise.resolve(path.split('/').pop() ?? '');
      },
      screenshot: (path: string) => {
        calls.push(`screenshot ${path.split('/').pop() ?? ''}`);
        return Promise.resolve();
      },
      text: () => Promise.resolve(this.text),
      close: () => {
        calls.push('close');
        return Promise.resolve();
      },
      /** Simula VOCÊ enviando na janela. */
      __userSubmits: () => {
        this.text = (current as FakePage).afterText ?? this.text;
      },
    };
    return Promise.resolve(page as PageDriver);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
