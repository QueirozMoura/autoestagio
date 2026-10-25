/**
 * Scripts executados DENTRO da página (via `page.evaluate`) para ler o formulário e os sinais de bloqueio. Só leem o
 * DOM e marcam cada campo com `data-ae` (atributo inofensivo) para o preenchimento localizar o elemento. Não clicam,
 * não enviam e não alteram valores.
 */
export const EXTRACT_FORM_SCRIPT = String.raw`(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && (r.width > 0 || r.height > 0);
  };
  const textOf = (el) => clean(el ? el.textContent : '');
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return textOf(l);
    }
    const wrap = el.closest('label');
    if (wrap) return textOf(wrap);
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i += 1, p = p.parentElement) {
      // Só o ancestral que contém apenas este campo (senão pegaria o rótulo de outro campo).
      const single = p.querySelectorAll('input, textarea, select').length === 1;
      const l = single || p.tagName === 'FIELDSET' ? p.querySelector(':scope > label, :scope > legend') : null;
      if (l && clean(l.textContent)) return textOf(l);
      if (single) {
        // Texto do componente SEM as listas de opções (senão o rótulo viraria "OpçãoAOpçãoB").
        const copy = p.cloneNode(true);
        copy.querySelectorAll('ul, ol, select, [role=listbox], script, style, button').forEach((n) => n.remove());
        const t = clean(copy.textContent);
        if (t && t.length <= 80) return t;
      }
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
  };
  const sectionOf = (el) => {
    const fs = el.closest('fieldset');
    if (fs) { const lg = fs.querySelector('legend'); if (lg) return textOf(lg); }
    let p = el;
    for (let i = 0; i < 6 && p && p.tagName !== 'BODY'; i += 1, p = p.parentElement) {
      let s = p.previousElementSibling;
      while (s) { if (/^H[1-4]$/.test(s.tagName)) return textOf(s); s = s.previousElementSibling; }
    }
    return '';
  };
  const ordered = [...document.querySelectorAll('input, textarea, select, [role=listbox]')];
  const listboxOf = (el) => {
    const ctl = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (ctl && document.getElementById(ctl)) return document.getElementById(ctl);
    // Lista logo depois do campo, na ordem do documento, sem outro campo no meio (listas "portal", como a do BTG).
    const next = ordered[ordered.indexOf(el) + 1];
    return next && next.getAttribute('role') === 'listbox' ? next : null;
  };
  const optionsOf = (lb) => lb ? [...lb.querySelectorAll('li, [role=option]')].map((o) => clean(o.textContent)).filter(Boolean) : [];
  // Asterisco "solto" (fora do <label>): vale se o ancestral próximo contém só este campo.
  const requiredHint = (el) => {
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i += 1, p = p.parentElement) {
      if (p.querySelectorAll('input, textarea, select').length !== 1) return false;
      const t = clean(p.textContent);
      if (t.length < 160 && /[*✱]/.test(t)) return true;
    }
    return false;
  };
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (el.getAttribute('role') === 'combobox') return 'other';
    if (listboxOf(el) && (el.getAttribute('type') || 'text') === 'text') return 'combobox';
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (['text', 'email', 'tel', 'url', 'number', 'radio', 'checkbox', 'file'].includes(t)) return t;
    return 'other';
  };
  const SKIP_TYPE = ['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search'];
  const SKIP_NAME = /g-recaptcha-response|h-captcha-response|honeypot|_gotcha|cf-turnstile/i;
  const fields = [];
  const seenGroups = new Set();
  let n = 0;
  let lastEl = null;
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (SKIP_TYPE.includes(type) || SKIP_NAME.test(el.getAttribute('name') || '') || el.disabled) continue;
    const kind = kindOf(el);
    if (kind !== 'file' && !isVisible(el) && kind !== 'radio' && kind !== 'checkbox') continue;
    if (kind === 'radio') {
      const group = el.getAttribute('name') || '';
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
    }
    // Entrada interna de um componente já lido (ex.: o campo de busca de uma lista): sem rótulo, nome nem dica.
    if (!clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '')) {
      let up = el.parentElement;
      let inner = false;
      for (let i = 0; i < 3 && up; i += 1, up = up.parentElement) if (lastEl && up.contains(lastEl)) { inner = true; break; }
      if (inner) continue;
    }
    n += 1;
    lastEl = el;
    const id = 'f' + n;
    el.setAttribute('data-ae', id);
    let label = labelOf(el);
    let options = [];
    if (kind === 'combobox') options = optionsOf(listboxOf(el));
    if (kind === 'select') options = [...el.options].map((o) => clean(o.textContent)).filter((o) => o && !/^(selecione|select|escolha|--)/i.test(o));
    if (kind === 'radio') {
      const group = el.getAttribute('name');
      const radios = [...document.querySelectorAll('input[type=radio]')].filter((r) => r.getAttribute('name') === group);
      options = radios.map((r) => labelOf(r));
      const fs = el.closest('fieldset');
      const lg = fs ? fs.querySelector('legend') : null;
      label = lg ? textOf(lg) : sectionOf(el) || label;
    }
    const labelText = label;
    fields.push({
      id,
      selector: '[data-ae="' + id + '"]',
      kind,
      label: labelText.replace(/\s*[*✱]\s*$/, ''),
      name: el.getAttribute('name') || el.id || '',
      placeholder: clean(el.getAttribute('placeholder') || ''),
      required: el.required || el.getAttribute('aria-required') === 'true' || /[*✱]/.test(labelText) || requiredHint(el),
      options,
      value: kind === 'file' || kind === 'radio' || kind === 'checkbox' ? '' : clean(el.value || ''),
      section: sectionOf(el),
    });
  }
  return { url: location.origin + location.pathname, title: document.title, fields };
})()`;

export const SIGNALS_SCRIPT = String.raw`(() => {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && r.width > 80 && r.height > 80;
  };
  const frames = [...document.querySelectorAll('iframe')];
  const challenge = frames.some((f) => /(bframe|hcaptcha.*challenge|challenge)/i.test(f.getAttribute('src') || '') && /(recaptcha|hcaptcha|turnstile)/i.test(f.getAttribute('src') || '') && isVisible(f));
  const present = !!document.querySelector('[data-sitekey], .g-recaptcha, .h-captcha, .cf-turnstile') ||
    [...document.querySelectorAll('iframe, script')].some((e) => /(recaptcha|hcaptcha|turnstile)/i.test(e.getAttribute('src') || ''));
  const submit = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
    .map((b) => (b.value || b.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => /(enviar|submit|candidat|apply|continuar|inscrever)/i.test(t))
    .slice(0, 5);
  const submitButton = [...document.querySelectorAll('button, input[type=submit], [role=button]')].find((b) =>
    /(submit application|enviar candidatura|candidatar|submit|enviar)/i.test((b.value || b.textContent || '').replace(/\s+/g, ' ').trim()) && (b.getAttribute('type') === 'submit' || /submit application|enviar candidatura/i.test(b.textContent || '')),
  );
  const submitEnabled = submitButton ? !(submitButton.disabled || submitButton.getAttribute('aria-disabled') === 'true') : null;
  const errors = [
    ...[...document.querySelectorAll('[aria-invalid="true"]')].map((e) => 'campo inválido: ' + ((e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || e.id || '?').slice(0, 60))),
    ...[...document.querySelectorAll('[role=alert], [class*=error-message], [class*=invalid-feedback], [class*=field-error]')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean),
  ].slice(0, 12);
  const pwd = [...document.querySelectorAll('input[type=password]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return {
    url: location.origin + location.pathname,
    title: document.title,
    text: (document.body.innerText || '').slice(0, 8000),
    hasPasswordInput: pwd,
    visibleCaptchaChallenge: challenge,
    captchaPresent: present,
    fieldCount: document.querySelectorAll('input:not([type=hidden]), textarea, select').length,
    submitLabels: submit,
    submitLabel: submitButton ? (submitButton.value || submitButton.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : null,
    submitEnabled,
    errors,
  };
})()`;
