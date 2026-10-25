/**
 * Modelos do executor assistido. Tudo aqui é serializável (sai do navegador como dado puro) para que a decisão de
 * preencher seja testável sem navegador.
 */
export type FieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'other';

export interface FieldModel {
  /** Identificador estável nesta página (data-ae). */
  id: string;
  selector: string;
  kind: FieldKind;
  /** Texto do rótulo/pergunta como a página mostra. */
  label: string;
  name: string;
  placeholder: string;
  required: boolean;
  options: string[];
  /** Valor que a página já trazia. */
  value: string;
  /** Título do grupo/seção (ex.: "Autodeclaração voluntária"). */
  section: string;
}

export interface PageSignals {
  url: string;
  title: string;
  /** Texto visível (limitado). */
  text: string;
  hasPasswordInput: boolean;
  /** Desafio de CAPTCHA VISÍVEL (não o script invisível que todo formulário carrega). */
  visibleCaptchaChallenge: boolean;
  /** Existe um widget/script de CAPTCHA na página (informativo: é avaliado só no envio). */
  captchaPresent: boolean;
  fieldCount: number;
  submitLabels: string[];
}

export interface FormModel {
  url: string;
  title: string;
  fields: FieldModel[];
}

export type FillOp = 'fill' | 'select' | 'upload';

export interface FillAction {
  fieldId: string;
  label: string;
  op: FillOp;
  value: string;
  /** De onde veio o valor (ex.: "applicant.email"). */
  source: string;
  /** Valor sensível (e-mail, telefone): aparece mascarado nos registros. */
  masked: boolean;
  /** Outras formas de escrever o MESMO dado (ex.: telefone com ou sem +55), tentadas se a máscara do campo recusar a primeira. */
  alternatives?: string[];
}

export type HumanCategory = 'sensivel' | 'consentimento' | 'confirmacao' | 'desconhecido';

export interface NeedsHuman {
  fieldId: string;
  label: string;
  category: HumanCategory;
  required: boolean;
  why: string;
}

export interface FillPlan {
  actions: FillAction[];
  /** Campos que dependem de você; os obrigatórios impedem o envio. */
  needsHuman: NeedsHuman[];
  /** Campos opcionais sem dado comprovado, deixados em branco. */
  skipped: { fieldId: string; label: string; why: string }[];
}

export type StepState = 'ok' | 'pulado' | 'bloqueado' | 'falhou';
export interface Step {
  step: string;
  state: StepState;
  detail: string;
}

export type ExecOutcome =
  | 'pronto_para_revisao'
  | 'campos_desconhecidos'
  | 'login'
  | 'captcha'
  | 'avaliacao'
  | 'encerrada'
  | 'sem_formulario'
  | 'erro'
  | 'concluida_com_evidencia';
