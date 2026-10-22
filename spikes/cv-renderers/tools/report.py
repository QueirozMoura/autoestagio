import json
r = json.load(open('out/results.json'))
EXT = ['poppler', 'poppler_layout', 'ghostscript', 'pypdf', 'pdfminer']
for rk, cfgs in r.items():
    for ck, v in cfgs.items():
        print(f"== {rk:11s} {ck:13s} pages={v['pages']} bytes={v['size_bytes']:>6} det={v['deterministic']} ms={v['render_ms']} fonts_ok={v['fonts_all_embedded_unicode']} links={v['link_annotations']}/{v['link_uris_match']}")
        for e in EXT:
            m = v['extractors'][e]
            print(f"     {e:14s} found={m['blocks_found']:>6} order={m['order_pct']:>5}% adj={m['title_period_adjacent']} head={m['headings_as_lines']} odd={m['cid_or_pua_or_fffd']} lig={m['ligature_codepoints']} bul={m['bullet_lines']}/{m['bullet_only_lines']} url={m['urls_in_text']} miss={m['missing'][:3]}")
