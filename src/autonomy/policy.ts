import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { PROJECT_ROOT } from '../utils/paths.js';

/**
 * Política do modo autônomo (config/autonomy.json, fora do Git). Tudo é opt-in: sem o arquivo, o modo está
 * DESLIGADO e só existe simulação. A autorização para envio real é um bloco separado, com validade e canais.
 */
const list = z.array(z.string().min(1)).default([]);

export const policySchema = z
  .strictObject({
    /** Liga o modo autônomo. Desligado por padrão. */
    enabled: z.boolean().default(false),
    /** Pretensão salarial padrão dos formulários. NÃO é a bolsa oferecida. */
    salaryExpectation: z
      .strictObject({
        amount: z.number().positive().default(1800),
        currency: z.string().length(3).default('BRL'),
      })
      .prefault({}),
    limits: z
      .strictObject({
        maxPerRun: z.number().int().min(0).max(100).default(5),
        maxPerDay: z.number().int().min(0).max(100).default(10),
        /** Pausa entre dois envios reais da mesma execução. */
        cooldownSeconds: z.number().int().min(0).max(3600).default(120),
        /** Uma execução "executando" mais antiga que isto é considerada morta e liberada. */
        lockTtlMinutes: z.number().int().min(5).max(1440).default(120),
      })
      .prefault({}),
    rules: z
      .strictObject({
        /** Tipos de fonte (greenhouse, lever, ashby...). Vazio = todas. */
        sourcesAllow: list,
        companiesAllow: list,
        /** Empresas que nunca recebem candidatura automática. */
        companiesDeny: list,
        /** Áreas de vaga (ex.: suporte, dados). Vazio = todas as áreas de TI. */
        areas: list,
        workModes: z
          .array(z.enum(['remoto', 'hibrido', 'presencial']))
          .min(1)
          .default(['remoto', 'hibrido', 'presencial']),
        /** Só se aplica quando a bolsa é divulgada; bolsa desconhecida nunca descarta. */
        minStipend: z.number().nonnegative().default(1200),
        /** "apto" é o padrão seguro; "revisao_humana" só entra se você incluir aqui. */
        verdicts: z
          .array(z.enum(['apto', 'revisao_humana']))
          .min(1)
          .default(['apto']),
        /**
         * Critérios obrigatórios que, quando DESCONHECIDOS (nunca quando reprovados), não impedem a candidatura.
         * "bolsa" (divulgada abaixo do mínimo continua descartando) e "modalidade" (desconhecida NUNCA vira remoto
         * nem híbrido; se um formulário pedir disponibilidade presencial, a resposta exige informação confirmada por você).
         * Vazio por padrão.
         */
        tolerateUnknown: z.array(z.enum(['bolsa', 'modalidade'])).default([]),
      })
      .prefault({}),
    /**
     * Pré-condição do envio REAL (a validade vem da concessão gravada no banco: `autonomo grant`). Sem os dois,
     * só simulação.
     */
    real: z
      .strictObject({
        authorized: z.boolean().default(false),
        /** Conectores permitidos (ex.: "email"). Vazio = nenhum. */
        connectors: list,
        /** Vincula a concessão ao manifesto completo de vagas, dados e permissões revistos. */
        autoApplyManifestSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .prefault({}),
  })
  .prefault({});

export type Policy = z.infer<typeof policySchema>;

export const DEFAULT_POLICY_PATH = `${PROJECT_ROOT}/config/autonomy.json`;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function parsePolicy(raw: unknown): Policy {
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PolicyError(
      `Política autônoma inválida em "${issue?.path.join('.') ?? ''}": ${issue?.message ?? 'erro'}.`,
    );
  }
  return parsed.data;
}

/** Sem arquivo: política padrão (desligada). Arquivo ilegível ou inválido: erro, nunca "valores padrão". */
export function loadPolicy(path: string = DEFAULT_POLICY_PATH): Policy {
  if (!existsSync(path)) return parsePolicy({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new PolicyError('config/autonomy.json não é um JSON válido.');
  }
  return parsePolicy(raw);
}

export const policyHash = (policy: Policy): string =>
  createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);

export interface GrantFacts {
  id: number;
  validUntil: string;
  policyHash: string;
  connectors: string[];
  maxPerDay: number;
  maxPerRun: number;
  minIntervalSeconds: number;
}

/** O envio real exige: política ligada, opt-in na política e concessão vigente, da política atual e com conector. */
export function realAuthorization(
  policy: Policy,
  grant: GrantFacts | null,
  now: Date,
): { ok: true; grant: GrantFacts } | { ok: false; reason: string } {
  if (!policy.enabled) return { ok: false, reason: 'modo autônomo desligado (enabled=false)' };
  if (!policy.real.authorized)
    return { ok: false, reason: 'envio real não autorizado (real.authorized=false)' };
  if (policy.real.connectors.length === 0)
    return { ok: false, reason: 'nenhum conector autorizado (real.connectors vazio)' };
  if (grant === null) return { ok: false, reason: 'sem concessão vigente (use "autonomo grant")' };
  if (grant.policyHash !== policyHash(policy))
    return {
      ok: false,
      reason: `a política mudou desde a concessão #${grant.id}; autorize de novo`,
    };
  if (now.toISOString() > grant.validUntil)
    return { ok: false, reason: `concessão #${grant.id} vencida` };
  const missing = policy.real.connectors.filter((c) => !grant.connectors.includes(c));
  if (missing.length > 0)
    return { ok: false, reason: `a concessão não cobre o conector: ${missing.join(', ')}` };
  return { ok: true, grant };
}
