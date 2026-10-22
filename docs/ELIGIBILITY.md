# Elegibilidade (Etapa 3.1)

Comando: `npm run dev -- analyze [--no-save] [--verdict apto|inapto|revisao_humana] [--verbose] [--json]`.
Só lê as vagas gravadas e grava o resultado em `job_eligibility`; não altera `jobs` e não envia nada.

## Veredito

- **apto**: todos os requisitos obrigatórios verificáveis são atendidos.
- **inapto**: ao menos um requisito obrigatório comprovadamente não é atendido.
- **revisão humana**: nenhum reprovado, mas há obrigatório sem como verificar (dado ausente na vaga ou no perfil).
- **Diferenciais** (seção "Diferenciais/Desejável", ou "diferencial" na frase) nunca mudam o veredito; só são contados.
- **Perfil sem `approval`** (não aprovado a partir do currículo): tudo vira revisão humana, com os motivos "provisórios".

## Regras

| Critério             | Regra                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Área                 | Título decide (Desenvolvimento, QA, Suporte, Infraestrutura, Dados, Banco de Dados). Área só na descrição = revisão. Fora de TI = inapto. |
| Bolsa                | ≥ R$ 1.200 atende; abaixo reprova; **não informada = pendente (revisão), nunca descartada**; faixa que cruza o mínimo = revisão.          |
| Modalidade           | Remoto, híbrido e presencial conforme o perfil; modalidade ausente nunca é presumida.                                                     |
| Local                | Híbrido/presencial só em São Paulo; outra cidade reprova; ambíguo = revisão. Remoto com restrição a outro país = revisão.                 |
| Deslocamento         | ≤ 70 min por trecho **somente** com tempo verificado em `commute` no perfil; sem tempo = "não verificável" (revisão). Nunca é estimado.   |
| Idioma               | Nível exigido × `languages` do perfil. Perfil sem o idioma = revisão. Menção fora de requisitos nunca reprova sozinha.                    |
| Curso                | Curso citado/áreas afins × curso do perfil; pós-graduação exigida reprova; curso diferente sem "afins" = revisão.                         |
| Semestre / formatura | Faixas comparadas ao semestre atual e ao ano previsto (por ano, sem mês).                                                                 |
| Disponibilidade      | Carga horária semanal (diária × 5) e data de início × `availability`.                                                                     |
| Tecnologias          | Exigida e ausente do perfil = revisão (conhecimento não é presumido); diferenciais só contam.                                             |

## Limitações conhecidas

- Leitura de texto por padrões; frases fora do padrão não geram critério (nada é inventado, mas pode faltar um requisito).
- Formatura é comparada por ano; início por mês. Períodos (manhã/tarde) ainda não são avaliados.
- Vocabulário de tecnologias fechado; o que não está nele é ignorado.
