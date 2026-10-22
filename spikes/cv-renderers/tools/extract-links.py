"""Extrai os hiperlinks de um PDF (somente leitura): URL da anotação + texto sob o retângulo do link."""
import json, subprocess, sys, re
from pypdf import PdfReader
pdf = sys.argv[1]
reader = PdfReader(pdf)
words = subprocess.run(['pdftotext', '-bbox', pdf, '-'], capture_output=True, text=True, check=True).stdout
boxes = [(float(a), float(b), float(c), float(d), t) for a, b, c, d, t in re.findall(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>', words)]
out = []
for pno, page in enumerate(reader.pages, 1):
    height = float(page.mediabox.height)
    for annot in page.get('/Annots', []) or []:
        a = annot.get_object()
        if a.get('/Subtype') != '/Link':
            continue
        action = a.get('/A')
        uri = action.get_object().get('/URI') if action is not None else None
        rx0, ry0, rx1, ry1 = [float(v) for v in a['/Rect']]
        x0, x1, y0, y1 = min(rx0, rx1), max(rx0, rx1), min(ry0, ry1), max(ry0, ry1)  # o /Rect pode vir com cantos invertidos
        # bbox do poppler usa origem no topo; converte o retângulo
        top, bottom = height - y1, height - y0
        # palavra pertence ao link se o CENTRO dela cai dentro do retângulo da anotação
        label = ' '.join(t for (xa, ya, xb, yb, t) in boxes if x0 - 1 <= (xa + xb) / 2 <= x1 + 1 and top - 1 <= (ya + yb) / 2 <= bottom + 1)
        out.append({'page': pno, 'label': label.strip(), 'url': str(uri) if uri is not None else None})
print(json.dumps(out, ensure_ascii=False, indent=2))
