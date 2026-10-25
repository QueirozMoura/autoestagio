import { loadProfile, verifyApprovedCv, type Profile } from '../config/index.js';

/** Perfil com a aprovação só se o currículo no disco for exatamente o aprovado (como o comando "analyze"). */
export function profileForRun(path: string): { profile: Profile; cvOk: boolean } {
  const loaded = loadProfile(path);
  if (loaded === undefined) throw new Error('Perfil não encontrado.');
  if (loaded.approval === undefined) return { profile: loaded, cvOk: false };
  const check = verifyApprovedCv(loaded);
  return check.ok
    ? { profile: loaded, cvOk: true }
    : { profile: { ...loaded, approval: undefined }, cvOk: false };
}
