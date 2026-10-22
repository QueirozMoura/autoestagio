# Spike 4.0 — renderizadores de currículo (PDF)

Experimento descartável que compara **PDFKit**, **HTML + WeasyPrint** e **LibreOffice headless** com
dados **fictícios** (Maria Exemplo). Não faz parte do produto: não é importado por `src/`, não entra em
`tsc`, lint, format, testes nem build. A decisão está em `docs/CV_RENDERER_SPIKE.md`.

## Reproduzir

```bash
cd spikes/cv-renderers
npm install                                   # só o pdfkit
python3 -m venv --without-pip .venv           # este Python não tem ensurepip
.venv/bin/python -I <get-pip.py oficial>      # ou: python3 -m venv .venv, se houver ensurepip
.venv/bin/python -m pip install weasyprint pypdf pdfminer.six
../../node_modules/.bin/tsx fixtures/make-fixture.ts   # gera e valida o fixture
../../node_modules/.bin/tsx tools/run.ts               # 3 renderizadores × 4 configurações
.venv/bin/python -I tools/report.py                    # resumo
../../node_modules/.bin/tsx tools/stress.ts            # caracteres especiais, QA, estouro de página
../../node_modules/.bin/tsx tools/model-checks.ts      # esquema proposto do modelo
```

Requer também `pdftotext/pdfinfo/pdffonts/pdftoppm` (Poppler), `gs` (Ghostscript), `soffice` (LibreOffice) e a
fonte Lato (OFL-1.1) instalada em `/usr/share/fonts/truetype/lato/`.

## Mapa

| Arquivo | Papel |
| --- | --- |
| `model.schema.ts` | **Proposta** do modelo de currículo em Zod (a implementação é a Etapa 4.1). |
| `fixtures/make-fixture.ts` | Gera `cv-fixture.json` (fictício) validado pelo esquema. |
| `view.ts` | Modelo → árvore de renderização comum (protótipo da seleção da 4.2) e o design A4 único. |
| `renderers/*.ts` | Os três renderizadores, com o mesmo design. |
| `tools/analyze.py` | Análise por 5 modos de extração (Poppler ×2, Ghostscript, pypdf, pdfminer). |
| `tools/run.ts`, `report.py`, `stress.ts`, `model-checks.ts` | Orquestração e verificações. |
| `tools/extract-links.py` | Extrai hiperlinks de um PDF (somente leitura). |
