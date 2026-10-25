import type { FieldModel, FormModel, PageSignals } from '../../src/executor/types.js';
import { parseApplicant } from '../../src/executor/applicant.js';

export const applicant = parseApplicant({
  fullName: 'Pessoa Exemplo da Silva',
  email: 'pessoa.exemplo@example.com',
  phone: '+5511999999999',
  city: 'São Paulo',
  state: 'SP',
  country: 'Brasil',
  linkedin: 'https://www.linkedin.com/in/exemplo/',
  github: 'https://github.com/exemplo',
});

let counter = 0;
export const field = (over: Partial<FieldModel> & { label: string }): FieldModel => {
  counter++;
  return {
    id: `f${counter}`,
    selector: `[data-ae="f${counter}"]`,
    kind: 'text',
    name: '',
    placeholder: '',
    required: false,
    options: [],
    value: '',
    section: '',
    ...over,
  };
};

export const form = (
  fields: FieldModel[],
  url = 'https://boards.exemplo.com/vaga/1',
): FormModel => ({
  url,
  title: 'Candidatura',
  fields,
});

export const signals = (over: Partial<PageSignals> = {}): PageSignals => ({
  url: 'https://boards.exemplo.com/vaga/1',
  title: 'Candidatura',
  text: 'Candidate-se a esta vaga. Preencha o formulário.',
  hasPasswordInput: false,
  visibleCaptchaChallenge: false,
  captchaPresent: true,
  fieldCount: 5,
  submitLabels: ['Enviar candidatura'],
  ...over,
});

/** Formulário no estilo Greenhouse: nome, e-mail, telefone, currículo, perguntas e autodeclaração. */
export const greenhouseLike = (): FormModel =>
  form([
    field({ label: 'First Name', kind: 'text', required: true }),
    field({ label: 'Last Name', kind: 'text', required: true }),
    field({ label: 'Email', kind: 'email', required: true }),
    field({ label: 'Phone', kind: 'tel', required: true }),
    field({ label: 'Resume/CV', kind: 'file', required: true }),
    field({ label: 'LinkedIn Profile', kind: 'text' }),
    field({ label: 'País', kind: 'select', required: true, options: ['Argentina', 'Brasil'] }),
    field({ label: 'Pretensão salarial (R$/mês)', kind: 'text', required: true }),
    field({ label: 'Cover Letter', kind: 'file' }),
  ]);
