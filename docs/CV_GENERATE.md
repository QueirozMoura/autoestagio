# Geração de currículos em PDF (`cv variants` e `cv generate`)

Interface local para consultar as variantes do currículo e gerar o PDF pelo **fluxo estrito**
(`renderAndValidateResume`). A CLI não tem renderização, validação ou gravação próprias: ela só
carrega as entradas (`src/cv/strict-inputs.ts`), chama o fluxo estrito e grava com
`src/utils/safe-write.ts`.

## Pré-requisitos

- Modelo mestre aprovado, declarações, aprovação global, manifesto de decisões e PDF mestre aprovado no
  perfil. São registros privados, fora do Git; a CLI **nunca** os cria, altera ou reconstrói.
- **Poppler** (`pdftotext`) instalado. É obrigatório e não há alternativa: sem ele a geração é bloqueada.
- Linux (a gravação segura depende de `/proc/self/fd`) e um filesystem com suporte a hardlink.
- A **referência da âncora de confiança**: o SHA-256 do arquivo de âncora autorizado, informado por
  quem executa em `--ancora-sha256`. Ela não é guardada em lugar nenhum, não é derivada dos arquivos que
  autentica e nenhuma âncora é escolhida automaticamente.

## Listar variantes

```bash
npm run dev -- cv variants --ancora-sha256 <hash> [--json]
```

Variantes: `generico`, `desenvolvimento`, `qa`, `infraestrutura`, `banco-de-dados`. Para cada uma:
estado editorial (aprovada, rascunho, rejeitada, ausente), elegibilidade de seleção e se as
pré-condições locais foram verificadas. **Não** executa a validação estrita nem mostra conteúdo,
caminhos privados ou hashes. Sem `--ancora-sha256` o estado editorial aparece, mas as pré-condições
ficam "indisponíveis".

## Gerar um PDF

```bash
npm run dev -- cv generate --variant <id> --ancora-sha256 <hash> [--output <diretório>] [--json]
```

1. valida o id da variante;
2. carrega e confere as entradas privadas (aprovação, âncora, decisões, mestre, fontes, Poppler);
3. executa `renderAndValidateResume`;
4. só publica se `ok`, `complete`, identidade das fontes e integridade das referências estiverem
   verificadas, sem pendências, com H1–H10 aprovados, Poppler usado e artefato com hash conferido;
5. grava com `writePrivateExclusive` e só então mostra o caminho.

Não existe flag para ignorar verificações, forçar `complete` ou sobrescrever (`--force`).

### Onde o arquivo é salvo

Padrão: `data/cv-output/` dentro do projeto (ignorado pelo Git; criado com 0700). Com `--output`, o
usuário escolhe apenas o **diretório**; o último nível é criado (0700) se não existir, mas o pai precisa
existir. O nome é sempre definido pelo programa:

```
curriculo-<variante>-<AAAAMMDD>-<sha8>.pdf      (sha8 = 8 primeiros hex do SHA-256 do PDF)
```

Arquivos têm modo 0600. Currículos idênticos (ex.: variantes com o mesmo conteúdo) produzem o mesmo
`sha8`, mas nomes diferentes por variante.

### Política de sobrescrita

Nunca sobrescreve. Se o destino existir (inclusive criado por outro processo durante a gravação), o
comando falha com `ALREADY_EXISTS` e o arquivo existente fica intacto.

### Saída

Sucesso: variante, caminho, páginas, estado da validação (`completa`) e durabilidade. `--json` traz
somente metadados (`ok`, `variant`, `path`, `pages`, `validation`, `durable`, `tempCleanup`) ou, na
falha, `stage`, `code`, `message` e códigos de problema.

Estados após a publicação (o PDF existe e é íntegro em todos eles):

| Situação                        | Saída                                                                 |
| ------------------------------- | --------------------------------------------------------------------- |
| Tudo confirmado                 | `Durabilidade: confirmada`                                            |
| fsync do diretório falhou       | `Durabilidade: NÃO confirmada` (sucesso; o arquivo foi publicado)     |
| Temporário não pôde ser apagado | aviso com o nome do temporário residual para remoção manual (sucesso) |

Falhas antes da publicação (`gravacao`/`validacao`/`carregamento`) saem com código 1 e dizem que
nenhum arquivo final foi criado. Um PDF já publicado nunca é removido para esconder uma falha posterior.

## Erros esperados

| Código                                               | Significado                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `VARIANT_UNKNOWN`                                    | Variante inexistente                                              |
| `VARIANT_NOT_ELIGIBLE`                               | Variante não aprovada                                             |
| `VARIANT_NOT_IN_DECISIONS`                           | Manifesto de decisões não cobre a variante                        |
| `ANCHOR_REFERENCE_MISSING` / `ANCHOR_MISMATCH`       | Referência da âncora ausente / não corresponde ao arquivo         |
| `ANCHOR_*`, `APPROVAL_*`, `DECISIONS_*`              | Registro ausente, corrompido ou divergente                        |
| `APPROVAL_STALE`                                     | Aprovação obsoleta: o modelo mudou depois de aprovado             |
| `DECLARATIONS_*`, `MODEL_*`, `MASTER_*`              | Dados privados ausentes, corrompidos ou incompatíveis             |
| `FONTS_INVALID`, `LOCAL_CONTEXT_INVALID`             | Fontes ou contexto local inválidos                                |
| `POPPLER_MISSING`                                    | Poppler indisponível                                              |
| `UNSAFE_FILE`                                        | Registro privado com permissões abertas ou link simbólico         |
| `VALIDATION_FAILED`                                  | Validação estrita incompleta (lista os códigos dos problemas)     |
| `OUTPUT_DIR_INVALID` / `OUTPUT_DIR_UNSAFE`           | Destino inválido / diretório de outro dono ou gravável por outros |
| `SYMLINK_REJECTED` / `SPECIAL_FILE`                  | Link simbólico ou arquivo especial no destino                     |
| `ALREADY_EXISTS`                                     | Arquivo já existe; nada foi sobrescrito                           |
| `LINK_UNSUPPORTED`                                   | Filesystem sem hardlink: gravação recusada (sem fallback)         |
| `WRITE_FAILED`, `INTEGRITY_FAILED`, `PUBLISH_FAILED` | Falha antes da publicação; nada foi publicado                     |

As mensagens não contêm conteúdo do currículo, hashes completos nem registros de aprovação.

## Limites de segurança

- A confiança parte da referência da âncora fornecida por quem executa. Hash não é assinatura: quem
  controla a sua conta e os seus arquivos controla a execução. O objetivo é impedir uso de dados
  obsoletos, divergentes ou adulterados por engano, não resistir a um atacante com acesso total.
- O diretório de saída é aberto uma vez (sem seguir links) e as operações seguintes usam o descritor,
  o que impede o redirecionamento por troca posterior do diretório. Os **ancestrais** do diretório são
  resolvidos antes da abertura: mantenha-os pertencendo ao seu usuário e não graváveis por outros.
- O diretório de saída precisa pertencer ao usuário e não ser gravável por grupo/outros.
- Publicação atômica (`link` + `unlink`) não equivale a durabilidade após queda de energia; veja
  `Durabilidade`. Uma queda do processo no meio da operação pode deixar um temporário `.….tmp` (0600),
  nunca com o nome final.
- A CLI não anexa nem envia nada; só grava o PDF localmente. PDFs são dados pessoais: não os versione.
