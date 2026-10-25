import type { ExecOutcome, FormModel, PageSignals } from './types.js';

/**
 * Classifica a página antes de qualquer preenchimento: vaga encerrada, login, desafio de CAPTCHA visível, avaliação ou
 * sem formulário. Funções puras sobre sinais já extraídos do navegador. Nada aqui contorna proteção: quando há login,
 * desafio visível ou avaliação, o item fica para você.
 */
const norm = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const CLOSED =
  /(vaga encerrada|inscricoes encerradas|encerrad[ao]\b.*(candidatur|inscric)|no longer accepting|position (has been )?filled|job (is )?no longer available|this job is closed|vaga nao esta mais disponivel|nao estamos mais recebendo|processo seletivo encerrado)/;
const CONFIRMATION =
  /(obrigad[oa] por se candidatar|candidatura (foi )?(enviada|recebida)|inscricao feita com sucesso|recebemos sua candidatura|application (has been )?(submitted|received)|thank you for (applying|your application)|thanks for applying)/;
const ASSESSMENT_HOST =
  /(hackerrank|codility|codingame|testgorilla|hackerearth|coderbyte|vervoe|kenzie)/;
const ASSESSMENT_TEXT =
  /(teste (tecnico|de logica|online|de conhecimentos)|desafio tecnico|assessment|avaliacao (tecnica|online)|prova online|coding (challenge|test))/;

export type PageVerdict =
  | { kind: 'ok'; notes: string[] }
  | {
      kind: 'bloqueada';
      outcome: Exclude<ExecOutcome, 'pronto_para_revisao' | 'campos_desconhecidos' | 'erro'>;
      why: string;
    };

export function classifyPage(signals: PageSignals, form: FormModel | null): PageVerdict {
  const text = norm(signals.text);
  const notes: string[] = [];
  if (CLOSED.test(text))
    return {
      kind: 'bloqueada',
      outcome: 'encerrada',
      why: 'a página informa que a vaga/inscrição está encerrada',
    };
  if (ASSESSMENT_HOST.test(norm(signals.url)))
    return {
      kind: 'bloqueada',
      outcome: 'avaliacao',
      why: 'a candidatura leva a uma plataforma de avaliação: o teste é seu',
    };
  const fields = form?.fields.length ?? signals.fieldCount;
  if (
    signals.hasPasswordInput &&
    (fields <= 6 ||
      /(signin|login|entrar|candidates\/signin)/.test(norm(signals.url)) ||
      /(entrar com sua conta|fa[cç]a login|sign in)/.test(text))
  )
    return {
      kind: 'bloqueada',
      outcome: 'login',
      why: 'a candidatura exige login na sua conta de candidato',
    };
  if (signals.visibleCaptchaChallenge)
    return {
      kind: 'bloqueada',
      outcome: 'captcha',
      why: 'há um desafio de CAPTCHA visível: só você o resolve',
    };
  if (fields === 0 || form === null || form.fields.length === 0) {
    if (ASSESSMENT_TEXT.test(text))
      return {
        kind: 'bloqueada',
        outcome: 'avaliacao',
        why: 'a página apresenta uma avaliação/teste e nenhum formulário de candidatura',
      };
    return {
      kind: 'bloqueada',
      outcome: 'sem_formulario',
      why: 'nenhum formulário de candidatura foi encontrado na página',
    };
  }
  if (ASSESSMENT_TEXT.test(text))
    notes.push(
      'o texto da vaga cita avaliação/teste na etapa seletiva: eles não são respondidos pelo executor',
    );
  if (signals.captchaPresent)
    notes.push('há proteção anti-robô no formulário (avaliada no envio, que é seu)');
  return { kind: 'ok', notes };
}

/** A página mostra a confirmação de que a candidatura foi recebida? Devolve o trecho como evidência. */
export function findConfirmation(text: string): string | null {
  const normalized = norm(text);
  const match = CONFIRMATION.exec(normalized);
  if (match === null) return null;
  const at = match.index;
  return text
    .replace(/\s+/g, ' ')
    .slice(Math.max(0, at - 20), at + 120)
    .trim();
}
