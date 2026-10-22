export const STATUSES = [
  'preparada',
  'aprovada_para_envio',
  'enviando',
  'enviada',
  'entrega_confirmada',
  'falhou',
  'pendente_intervencao_humana',
] as const;
export type Status = (typeof STATUSES)[number];

export const MODES = ['dry-run', 'revisao', 'auto'] as const;
export type Mode = (typeof MODES)[number];

export const CHANNELS = ['email', 'portal', 'manual'] as const;
export type Channel = (typeof CHANNELS)[number];

export type Actor = 'sistema' | 'usuario';

export const STATUS_LABELS: Record<Status, string> = {
  preparada: 'preparada',
  aprovada_para_envio: 'aprovada para envio',
  enviando: 'envio em andamento',
  enviada: 'enviada',
  entrega_confirmada: 'entrega confirmada',
  falhou: 'falhou',
  pendente_intervencao_humana: 'pendente de intervenção humana',
};

/**
 * Transições permitidas. `enviando` existe para a recuperação após falhas: se o processo cair
 * entre "reservar o envio" e "registrar o resultado", a candidatura fica marcada e nunca é
 * reenviada sozinha (não dá para saber se saiu).
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  preparada: ['aprovada_para_envio', 'pendente_intervencao_humana', 'falhou'],
  aprovada_para_envio: ['enviando', 'preparada', 'pendente_intervencao_humana', 'falhou'],
  // Resultado do envio: aceito, rejeitado com certeza, ou desconhecido (→ humano).
  enviando: ['enviada', 'falhou', 'pendente_intervencao_humana'],
  enviada: ['entrega_confirmada', 'pendente_intervencao_humana'],
  entrega_confirmada: [],
  // Retentativa só se nunca foi enviada (ver guardas em service.ts).
  falhou: ['preparada'],
  // Só uma pessoa resolve: confirma que foi enviada/entregue, que não foi, ou refaz o preparo.
  pendente_intervencao_humana: ['preparada', 'enviada', 'entrega_confirmada', 'falhou'],
};

export const TERMINAL: ReadonlySet<Status> = new Set<Status>(['entrega_confirmada']);

/** Estados em que a candidatura já saiu (ou pode ter saído) e não pode mais ser reenviada. */
export const SENT_STATES: ReadonlySet<Status> = new Set<Status>([
  'enviando',
  'enviada',
  'entrega_confirmada',
]);
