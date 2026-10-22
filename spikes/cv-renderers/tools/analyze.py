"""
Análise de um PDF de currículo por proxies de compatibilidade com ATS. Não prova aprovação em nenhum
ATS real (cada um tem o seu parser); mede o que parsers de texto costumam exigir:
  - o texto sai completo, sem caracteres estranhos e com acentos/ligaduras corretos;
  - a ordem de leitura é a do documento;
  - datas ficam junto do título; contato e links saem inteiros;
  - fontes embutidas com ToUnicode; sem texto-imagem; estrutura (tags) quando houver.
Uso: analyze.py <pdf> <expected.json>   (imprime JSON)
"""
import json, re, subprocess, sys, unicodedata
from pypdf import PdfReader
from pdfminer.high_level import extract_text as pdfminer_text

pdf, expected_path = sys.argv[1], sys.argv[2]
expected = json.load(open(expected_path, encoding='utf-8'))
blocks = expected['blocks']          # [{id,text}] na ordem de leitura
links = expected['links']            # [{label,url}]
headings = expected['headings']
email, phone = expected['email'], expected['phone']

def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout

def squash(s):
    s = unicodedata.normalize('NFKC', s).replace('\u00ad', '').replace('|', '')
    return re.sub(r'\s+', '', s).casefold()

# ---- metadados / fontes ------------------------------------------------------------
info = run(['pdfinfo', pdf])
def field(name):
    m = re.search(rf'^{name}:\s*(.*)$', info, re.M)
    return m.group(1).strip() if m else None
fonts_raw = run(['pdffonts', pdf]).splitlines()[2:]
fonts = []
for line in fonts_raw:
    cols = line.split()
    if len(cols) >= 7:
        fonts.append({'name': cols[0], 'embedded': cols[-5] == 'yes', 'subset': cols[-4] == 'yes', 'to_unicode': cols[-3] == 'yes'})

reader = PdfReader(pdf)
meta = {k: str(v) for k, v in (reader.metadata or {}).items()}
root = reader.trailer['/Root']
tagged = '/StructTreeRoot' in root
struct_types = {}
if tagged:
    seen = set()
    def walk(node, depth=0):
        node = node.get_object() if hasattr(node, 'get_object') else node
        if id(node) in seen or depth > 40 or not hasattr(node, 'get'):
            return
        seen.add(id(node))
        s = node.get('/S')
        if s is not None:
            struct_types[str(s)] = struct_types.get(str(s), 0) + 1
        k = node.get('/K')
        if k is None:
            return
        kids = k if isinstance(k, list) else [k]
        for kid in kids:
            kid = kid.get_object() if hasattr(kid, 'get_object') else kid
            if hasattr(kid, 'get'):
                walk(kid, depth + 1)
    walk(root['/StructTreeRoot'])

uris = []
for page in reader.pages:
    for annot in page.get('/Annots', []) or []:
        a = annot.get_object()
        action = a.get('/A')
        if action is not None and action.get_object().get('/URI') is not None:
            uris.append(str(action.get_object()['/URI']))

# ---- extratores ----------------------------------------------------------------------
extractors = {
    'poppler': run(['pdftotext', '-enc', 'UTF-8', pdf, '-']),
    'poppler_layout': run(['pdftotext', '-layout', '-enc', 'UTF-8', pdf, '-']),
    'ghostscript': run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite', '-sOutputFile=-', pdf]),
    'pypdf': '\n'.join((p.extract_text() or '') for p in reader.pages),
    'pdfminer': pdfminer_text(pdf),
}

def lis(seq):
    import bisect
    tails = []
    for x in seq:
        i = bisect.bisect_left(tails, x)
        if i == len(tails): tails.append(x)
        else: tails[i] = x
    return len(tails)

results = {}
for name, raw in extractors.items():
    sq = squash(raw)
    found, missing, in_order, pointer = 0, [], 0, 0
    for b in blocks:
        s_ = squash(b['text'])
        pos = sq.find(s_, pointer)           # busca para frente: respeita a ordem esperada
        if pos >= 0:
            found += 1
            in_order += 1
            pointer = pos + len(s_)
        elif sq.find(s_) >= 0:               # existe, mas fora da ordem esperada
            found += 1
        else:
            missing.append(b['id'])
    order = (in_order / found) if found else 0
    # título + período adjacentes (data não "solta" em outro ponto do texto)
    adjacency = []
    for b in blocks:
        if b['id'].endswith(':period'):
            title = next(x for x in blocks if x['id'] == b['id'][:-7])
            adjacency.append((squash(title['text']) + squash(b['text'])) in sq)
    odd = sum(1 for ch in raw if (0xE000 <= ord(ch) <= 0xF8FF) or ch == '�' or (ord(ch) < 32 and ch not in '\n\r\t\f'))
    lig = sum(1 for ch in raw if 0xFB00 <= ord(ch) <= 0xFB06)
    lines = [l.strip() for l in raw.splitlines()]
    bullet_only = sum(1 for l in lines if l in ('•', '-', '*'))
    bullet_lines = sum(1 for l in lines if l.startswith('•'))
    results[name] = {
        'chars': len(raw),
        'blocks_found': f'{found}/{len(blocks)}',
        'blocks_found_pct': round(100 * found / len(blocks), 1),
        'missing': missing[:6],
        'order_pct': round(100 * order, 1),
        'title_period_adjacent': f'{sum(adjacency)}/{len(adjacency)}',
        'email_intact': email.casefold() in raw.casefold(),
        'phone_intact': phone in raw,
        'headings_as_lines': f"{sum(1 for h in headings if h in lines)}/{len(headings)}",
        'cid_or_pua_or_fffd': odd + raw.count('(cid:'),
        'ligature_codepoints': lig,
        'bullet_lines': bullet_lines,
        'bullet_only_lines': bullet_only,
        'urls_in_text': f"{sum(1 for l in links if l['url'] in re.sub(r'\\s+', '', raw))}/{len(links)}",
    }

# imagens/texto-imagem
images = run(['pdfimages', '-list', pdf]).strip().splitlines()[2:] if subprocess.run(['which', 'pdfimages'], capture_output=True).returncode == 0 else []

expected_uris = sorted(set(l['url'] for l in links + expected.get('entry_links', [])))
print(json.dumps({
    'pdf': pdf,
    'bytes': int(re.search(r'File size:\s*(\d+)', info).group(1)),
    'pages': int(field('Pages')),
    'page_size': field('Page size'),
    'tagged_flag': field('Tagged'),
    'producer': field('Producer'),
    'creator': field('Creator'),
    'metadata_keys': sorted(meta.keys()),
    'metadata_leaks': [k for k, v in meta.items() if re.search(r'/home/|/tmp/|gustavo|claude', v, re.I)],
    'fonts': fonts,
    'fonts_all_embedded_unicode': all(f['embedded'] and f['to_unicode'] for f in fonts),
    'struct_tree': tagged,
    'struct_types': struct_types,
    'images': len(images),
    'link_annotations': len(uris),
    'link_uris_match': sorted(set(uris)) == expected_uris,
    'extractors': results,
}, ensure_ascii=False, indent=2))
