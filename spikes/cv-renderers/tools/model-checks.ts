/** Confere o esquema PROPOSTO do modelo: aceita o fixture fictício e rejeita o que precisa ser rejeitado. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cvModelSchema } from '../model.schema.ts';

const base = JSON.parse(readFileSync(new URL('../fixtures/cv-fixture.json', import.meta.url), 'utf8')) as Record<string, any>;
const clone = (): Record<string, any> => structuredClone(base);
const rejects = (name: string, mutate: (m: Record<string, any>) => void, expected: RegExp): void => {
  const model = clone();
  mutate(model);
  const result = cvModelSchema.safeParse(model);
  assert.equal(result.success, false, `deveria rejeitar: ${name}`);
  assert.match(JSON.stringify(result.error?.issues), expected, name);
  console.log(`ok  rejeita: ${name}`);
};

assert.equal(cvModelSchema.safeParse(base).success, true);
console.log('ok  aceita o fixture fictício');

rejects('texto sem pt-BR', (m) => { delete m.summary.variants[0].text['pt-BR']; }, /pt-BR/);
rejects('bloco sem variantes', (m) => { m.summary.variants = []; }, /too_small|>=1/);
rejects('variante sem sourceRef (sem origem no mestre)', (m) => { delete m.summary.variants[0].sourceRef; }, /sourceRef/);
rejects('SHA do mestre inválido', (m) => { m.master.sha256 = 'abc'; }, /sha256/);
rejects('id duplicado em todo o modelo', (m) => { m.experience[1].id = m.experience[0].id; }, /id repetido/);
rejects('id de variante duplicado', (m) => { m.summary.variants[1].id = m.summary.variants[0].id; }, /id repetido/);
rejects('URL que não é http(s)', (m) => { m.identity.links[0].url = 'javascript:alert(1)'; }, /url|invalid/i);
rejects('área desconhecida', (m) => { m.summary.variants[0].areas = ['marketing']; }, /areas/);
rejects('versão de esquema desconhecida', (m) => { m.schemaVersion = 2; }, /schemaVersion/);
rejects('documento em inglês sem a versão em inglês das variantes', (m) => { m.language = 'en'; }, /falta a versão em inglês/);
rejects('data de aprovação inválida', (m) => { m.summary.variants[0].approvedAt = 'ontem'; }, /approvedAt/);
rejects('período fora do formato', (m) => { m.experience[0].period.start = '26'; }, /AAAA/);

// A arquitetura comporta o inglês: com as versões em inglês presentes, o documento em inglês é aceito.
const en = clone();
en.language = 'en';
for (const v of en.summary.variants) v.text.en = 'English text (placeholder)';
assert.equal(cvModelSchema.safeParse(en).success, true);
console.log('ok  aceita documento em inglês quando há versões em inglês (variante futura já comportada)');
