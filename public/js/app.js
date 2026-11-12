(function () {
  'use strict';
  const { THEMES, ACCENTS, render, esc } = window.Templates;
  const $ = (s) => document.querySelector(s);
  const CURRENT_KEY = 'resumely.current';

  const state = { sample: null, list: [], resume: null, llm: false, me: { signedIn: false }, googleClientId: null };

  /* ---------- API ---------- */
  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(url, opt);
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.startsWith('/api/auth/')) signedOut();
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }
  const remember = (id) => { try { if (id) localStorage.setItem(CURRENT_KEY, id); else localStorage.removeItem(CURRENT_KEY); } catch (e) {} };
  const remembered = () => { try { return localStorage.getItem(CURRENT_KEY); } catch (e) { return null; } };

  async function openResume(id) {
    state.resume = await api('GET', `/api/resumes/${id}`);
    remember(id);
  }
  async function refreshList() {
    state.list = await api('GET', '/api/resumes');
  }

  /* ---------- sheet scaling ---------- */
  const ro = new ResizeObserver((es) => es.forEach((e) => fit(e.target)));
  function fit(w) {
    const s = w.querySelector('.sheet');
    if (!s) return;
    const k = w.clientWidth / 794;
    s.style.transform = `scale(${k})`;
    if (w.id === 'paper') {
      const h = Math.max(1123, s.offsetHeight);
      w.style.height = `${h * k}px`;
      let m = w.querySelector('.page-end');
      const over = s.offsetHeight > 1125;
      if (over && !m) { m = document.createElement('div'); m.className = 'page-end'; m.innerHTML = '<span>Page 1 ends here</span>'; w.appendChild(m); }
      if (m) { m.hidden = !over; m.style.top = `${1123 * k}px`; }
      setPageWarning(over);
    }
  }
  function mount(w, theme, data, accent) { w.innerHTML = render(data, theme, accent); fit(w); ro.observe(w); }

  /* ---------- routing ---------- */
  const VIEWS = ['home', 'upload', 'themes', 'editor'];
  function route() {
    let v = (location.hash || '#home').slice(1);
    if (!VIEWS.includes(v)) v = 'home';
    if (v !== 'home' && !state.me.signedIn) {
      v = 'home';
      history.replaceState(null, '', '#home');
    }
    if ((v === 'themes' || v === 'editor') && !state.resume) {
      v = 'upload';
      history.replaceState(null, '', '#upload');
      toast('Upload your resume first so we have your details.');
    }
    VIEWS.forEach((x) => { $(`#view-${x}`).hidden = x !== v; });
    $('#steps').hidden = v === 'home';
    document.querySelectorAll('.step').forEach((b) => {
      const g = b.dataset.go;
      b.setAttribute('aria-current', g === v ? 'step' : 'false');
      b.classList.toggle('done', VIEWS.indexOf(g) < VIEWS.indexOf(v));
      b.disabled = g !== 'upload' && !state.resume;
    });
    ({ home: renderHome, upload: renderUpload, themes: renderThemes, editor: renderEditor })[v]();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); location.hash = g.dataset.go; }
  });

  /* ---------- home ---------- */
  function renderHome() {
    const inside = state.me.signedIn;
    $('#home-cta').hidden = !inside;
    $('#home-gate').hidden = inside;
    if (!state.googleClientId) $('#home-gate .gate-note').textContent = 'Sign-in is not set up on this server yet (GOOGLE_CLIENT_ID is empty).';
    if (!inside) renderGoogleButton($('#gbtn-home'), 'large');
    const data = (state.resume && state.resume.data) || state.sample;
    if (!data) return;
    document.querySelectorAll('#view-home [data-render]').forEach((w) => mount(w, w.dataset.render, data, (state.resume && state.resume.accent) || ACCENTS[0][1]));
  }
  async function startSample() {
    try {
      const r = await api('POST', '/api/resumes/sample');
      state.resume = r; remember(r.id); await refreshList();
      location.hash = 'themes';
    } catch (e) { toast(e.message); }
  }
  $('#home-sample').addEventListener('click', startSample);
  $('#upload-sample').addEventListener('click', startSample);

  /* ---------- upload ---------- */
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  function renderUpload() {
    $('#drop').hidden = false;
    $('#progress').hidden = true;
    renderRecent();
  }
  function renderRecent() {
    const box = $('#recent');
    box.hidden = !state.list.length;
    $('#recent-list').innerHTML = state.list.map((r) => `<li>
      <div class="rt"><b>${esc(r.name || r.title)}</b><span>${esc(r.title)} · ${esc(cap(r.theme))} · edited ${fmtDate(r.updatedAt)}</span></div>
      <button class="btn" data-open="${r.id}">Open</button>
      <button class="del" data-del="${r.id}" aria-label="Delete ${esc(r.title)}">Delete</button></li>`).join('');
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  $('#recent-list').addEventListener('click', async (e) => {
    const o = e.target.closest('[data-open]');
    const d = e.target.closest('[data-del]');
    try {
      if (o) { await openResume(o.dataset.open); location.hash = 'editor'; }
      if (d) {
        if (d.dataset.armed !== '1') { d.dataset.armed = '1'; d.textContent = 'Click again to delete'; setTimeout(() => { d.dataset.armed = ''; d.textContent = 'Delete'; }, 3000); return; }
        await api('DELETE', `/api/resumes/${d.dataset.del}`);
        if (state.resume && state.resume.id === d.dataset.del) { state.resume = null; remember(null); }
        await refreshList(); renderRecent(); toast('Resume deleted');
      }
    } catch (err) { toast(err.message); }
  });

  function setChecks(n, failAt) {
    document.querySelectorAll('#checks li').forEach((li, i) => {
      li.className = failAt === i ? 'fail' : i < n ? 'on' : i === n ? 'run' : '';
    });
  }
  async function handleFile(file) {
    if (!file) return;
    if (!/\.(pdf|docx|txt)$/i.test(file.name)) { toast("That file type isn't supported. Upload a PDF, DOCX or TXT file."); return; }
    if (file.size > 10 * 1048576) { toast('That file is over 10 MB. Upload a smaller copy.'); return; }
    $('#drop').hidden = true; $('#progress').hidden = false;
    $('#fname').textContent = file.name; $('#fsize').textContent = fmtSize(file.size);
    ['#found', '#extract-note', '#upload-err', '#upload-next'].forEach((s) => { $(s).hidden = true; });
    setChecks(0);
    const fd = new FormData(); fd.append('resume', file);
    let step = 0;
    const t = setInterval(() => { if (step < 2) setChecks(++step); }, 700);
    try {
      const r = await api('POST', '/api/resumes', fd);
      clearInterval(t); setChecks(3);
      state.resume = r; remember(r.id); await refreshList();
      showFound(r);
    } catch (e) {
      clearInterval(t); setChecks(step, step);
      $('#upload-err').textContent = e.message; $('#upload-err').hidden = false;
      $('#upload-next').hidden = false;
    }
  }
  function showFound(r) {
    const d = r.data;
    const n = d.skills.reduce((a, g) => a + g.items.length, 0);
    $('#found').innerHTML = [[d.experience.length, 'roles'], [n, 'skills'], [d.projects.length, 'projects'], [d.education.length, 'schools']]
      .map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('');
    $('#found').hidden = false;
    $('#extract-note').textContent = r.extractedBy === 'llm'
      ? 'Read with the AI model. Check names and dates in the editor.'
      : 'Read with built-in rules. Some details may land in the wrong place; you can fix any line in the editor.';
    $('#extract-note').hidden = false;
    $('#upload-next').hidden = false;
  }
  $('#file').addEventListener('change', (e) => handleFile(e.target.files[0]));
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
  $('#reupload').addEventListener('click', () => { $('#file').value = ''; renderUpload(); });

  /* ---------- themes ---------- */
  async function patch(body) {
    const r = state.resume;
    Object.assign(r, body);
    try { await api('PATCH', `/api/resumes/${r.id}`, body); setMeta('saved'); } catch (e) { setMeta('error'); toast(e.message); }
  }
  function renderSwatches(onPick) {
    const box = $('#swatches');
    box.querySelectorAll('.sw').forEach((n) => n.remove());
    ACCENTS.forEach(([n, c]) => {
      const b = document.createElement('button');
      b.className = 'sw'; b.style.background = c; b.title = n; b.setAttribute('aria-label', `${n} accent`);
      b.setAttribute('aria-pressed', String(state.resume.accent === c));
      b.onclick = () => { patch({ accent: c }); onPick(); };
      box.appendChild(b);
    });
  }
  function renderThemes() {
    renderSwatches(renderThemes);
    const g = $('#theme-grid');
    g.innerHTML = '';
    THEMES.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'theme-card';
      b.setAttribute('aria-pressed', String(state.resume.theme === t.id));
      b.innerHTML = `<div class="sheet-wrap"></div><div><h3>${t.name}</h3><p>${t.desc}</p></div>`;
      b.onclick = () => { patch({ theme: t.id }); g.querySelectorAll('.theme-card').forEach((c) => c.setAttribute('aria-pressed', String(c === b))); };
      b.ondblclick = () => { location.hash = 'editor'; };
      g.appendChild(b);
      mount(b.querySelector('.sheet-wrap'), t.id, state.resume.data, state.resume.accent);
    });
  }

  /* ---------- editor ---------- */
  let pageOver = false;
  function setPageWarning(over) { pageOver = over; setMeta(); }
  let metaState = '';
  function setMeta(s) {
    if (s !== undefined) metaState = s;
    const el = $('#meta');
    if (!el || !state.resume) return;
    const parts = [];
    if (metaState === 'saving') parts.push('Saving…');
    if (metaState === 'saved') parts.push('Saved');
    if (metaState === 'error') parts.push('Not saved');
    if (pageOver) parts.push('Runs past one page');
    parts.push(cap(state.resume.theme), 'A4');
    el.textContent = parts.join(' · ');
    el.classList.toggle('warn', pageOver || metaState === 'error');
  }
  function renderSeg() {
    const s = $('#theme-seg');
    s.innerHTML = '';
    THEMES.forEach((t) => {
      const b = document.createElement('button');
      b.textContent = t.name;
      b.setAttribute('aria-pressed', String(state.resume.theme === t.id));
      b.onclick = () => { patch({ theme: t.id }); renderSeg(); paint(); };
      s.appendChild(b);
    });
  }
  function paint(flashSec) {
    const paper = $('#paper');
    const r = state.resume;
    mount(paper, r.theme, r.data, r.accent);
    paper.querySelectorAll('[data-p]').forEach((el) => {
      el.contentEditable = 'plaintext-only';
      if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
      el.spellcheck = true;
    });
    $('#download').href = `/api/resumes/${r.id}/pdf`;
    setMeta();
    if (flashSec) {
      const el = paper.querySelector(`[data-sec="${flashSec}"]`);
      if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    }
  }
  function renderEditor() {
    const st = $('#llm-status');
    st.textContent = state.llm ? 'AI connected' : 'Basic mode';
    st.classList.toggle('live', state.llm);
    st.title = state.llm ? '' : 'The language model is not connected yet, so the assistant handles a few direct commands';
    renderSeg(); paint(); drawChat(); drawChips();
  }

  /* direct editing on the page: no LLM involved */
  const getP = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function setP(o, p, v) { const k = p.split('.'); const last = k.pop(); k.reduce((a, x) => a[x], o)[last] = v; }
  function listItem(p) {
    const k = p.split('.');
    const i = Number(k[k.length - 1]);
    if (!Number.isInteger(i)) return null;
    const arrPath = k.slice(0, -1).join('.');
    const arr = getP(state.resume.data, arrPath);
    return Array.isArray(arr) && /(bullets|certifications|contact|items)$/.test(arrPath) ? { arrPath, arr, i } : null;
  }
  function focusPath(p) {
    const el = $('#paper').querySelector(`[data-p="${p}"]`);
    if (!el) return;
    el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  let saveTimer;
  function queueSave() {
    setMeta('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => patch({ data: state.resume.data }), 600);
  }
  const paperEl = $('#paper');
  paperEl.addEventListener('input', (e) => {
    const el = e.target.closest('[data-p]');
    if (!el) return;
    const v = el.innerText.replace(/\s*\n\s*/g, ' ');
    setP(state.resume.data, el.dataset.p, el.hasAttribute('data-list') ? v.split(/\s*,\s*/).filter(Boolean) : v);
    fit(paperEl);
    queueSave();
  });
  paperEl.addEventListener('paste', (e) => {
    if (!e.target.closest('[data-p]')) return;
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text').replace(/\s*\n\s*/g, ' '));
  });
  paperEl.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-p]');
    if (!el) return;
    const li = listItem(el.dataset.p);
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!li) { el.blur(); return; }
      li.arr.splice(li.i + 1, 0, '');
      paint(); focusPath(`${li.arrPath}.${li.i + 1}`); queueSave();
      return;
    }
    if (e.key === 'Backspace' && li && !el.innerText.trim() && li.arr.length > 1) {
      e.preventDefault();
      li.arr.splice(li.i, 1);
      paint(); focusPath(`${li.arrPath}.${Math.max(0, li.i - 1)}`); queueSave();
      return;
    }
    if (e.key === 'Escape') el.blur();
  });
  paperEl.addEventListener('focusout', (e) => {
    const el = e.target.closest('[data-p]');
    if (!el) return;
    const li = listItem(el.dataset.p);
    if (li && !String(li.arr[li.i] || '').trim() && li.arr.length > 1) {
      li.arr.splice(li.i, 1); queueSave();
      setTimeout(() => { if (!paperEl.contains(document.activeElement)) paint(); }, 0);
    }
  });

  $('#download').addEventListener('click', async (e) => {
    if (metaState === 'saving') { e.preventDefault(); clearTimeout(saveTimer); await patch({ data: state.resume.data }); location.href = $('#download').href; }
    toast('Preparing your PDF…');
  });

  /* chat */
  function drawChat() {
    const msgs = state.resume.chat.length ? state.resume.chat : [{ role: 'assistant', text: `I've loaded ${state.resume.file ? 'your resume' : 'the sample resume'}. Click any line on the page to edit it yourself, or tell me what to change.` }];
    $('#msgs').innerHTML = msgs.map((m) => (m.role === 'user'
      ? `<div class="msg user">${esc(m.text)}</div>`
      : `<div class="msg bot"><div class="who"><i></i>Assistant</div>${esc(m.text)}${m.change ? `<br><span class="change">${esc(m.change)}</span>` : ''}</div>`)).join('');
    const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  }
  const CHIPS = ['Shorten my summary', 'Add skill Redux', 'Switch to the Timeline theme', 'Change my title to Frontend Engineer', 'Remove the projects section'];
  function drawChips() {
    const c = $('#chips'); c.innerHTML = '';
    CHIPS.forEach((t) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = t; b.onclick = () => send(t); c.appendChild(b); });
  }
  let sending = false;
  async function send(text) {
    text = (text || '').trim();
    if (!text || sending) return;
    sending = true;
    clearTimeout(saveTimer);
    if (metaState === 'saving') await patch({ data: state.resume.data });
    const r = state.resume;
    r.chat.push({ role: 'user', text }); drawChat();
    const box = $('#msgs');
    const ty = document.createElement('div');
    ty.className = 'msg bot typing';
    ty.innerHTML = '<div class="who"><i></i>Assistant</div><span></span><span></span><span></span>';
    box.appendChild(ty); box.scrollTop = box.scrollHeight;
    input.value = ''; $('#send').disabled = true; autoGrow();
    try {
      const out = await api('POST', `/api/resumes/${r.id}/chat`, { message: text });
      r.chat.pop(); r.chat.push(...out.messages);
      r.data = out.data;
      if (out.theme !== r.theme) { r.theme = out.theme; renderSeg(); }
      drawChat(); paint(out.section);
    } catch (e) {
      ty.remove(); toast(e.message);
    } finally { sending = false; }
  }
  const input = $('#chat-input');
  function autoGrow() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; }
  input.addEventListener('input', () => { $('#send').disabled = !input.value.trim(); autoGrow(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); } });
  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });

  /* account: optional Google sign-in */
  function renderAccount() {
    const box = $('#account');
    const me = state.me;
    if (me.signedIn) {
      const face = me.picture
        ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">`
        : `<b class="initial">${esc((me.name || me.email || '?')[0].toUpperCase())}</b>`;
      box.innerHTML = `<div class="who" title="${esc(me.email)}">${face}<span>${esc(me.name || me.email)}</span></div>
        <button class="btn out" id="sign-out">Sign out</button>`;
      $('#sign-out').addEventListener('click', signOut);
      return;
    }
    box.innerHTML = '';
  }
  function renderGoogleButton(el, size) {
    if (!el || !state.googleClientId) return;
    loadGoogle().then((g) => {
      if (!gInit) { g.accounts.id.initialize({ client_id: state.googleClientId, callback: onGoogleCredential, ux_mode: 'popup', context: 'signin' }); gInit = true; }
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      g.accounts.id.renderButton(el, { type: 'standard', theme: dark ? 'filled_black' : 'outline', size, text: 'signin_with', shape: 'pill', width: size === 'large' ? 280 : undefined });
    }).catch(() => toast('Could not load Google sign-in. Check your connection and reload.'));
  }
  let gInit = false;
  let gLoad;
  function loadGoogle() {
    if (window.google && window.google.accounts) return Promise.resolve(window.google);
    gLoad = gLoad || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => resolve(window.google); s.onerror = reject;
      document.head.appendChild(s);
    });
    return gLoad;
  }
  async function onGoogleCredential(resp) {
    try {
      const { user } = await api('POST', '/api/auth/google', { credential: resp.credential });
      state.me = user; renderAccount();
      await refreshList();
      const id = remembered();
      const pick = state.list.find((r) => r.id === id) || state.list[0];
      if (pick) await openResume(pick.id).catch(() => remember(null));
      toast(`Signed in as ${user.name || user.email}`);
      if (location.hash === '#upload') route(); else location.hash = 'upload';
    } catch (e) { toast(e.message); }
  }
  async function signOut() {
    try {
      await api('POST', '/api/auth/logout');
      if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
      remember(null); signedOut();
      toast('Signed out');
    } catch (e) { toast(e.message); }
  }

  // Back to the signed-out home page (after sign-out, or when the session has ended).
  function signedOut() {
    if (!state.me.signedIn) return;
    state.me = { signedIn: false }; state.resume = null; state.list = [];
    renderAccount();
    if (location.hash && location.hash !== '#home') location.hash = 'home'; else route();
  }

  /* toast */
  let tt;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => { el.hidden = true; }, 3200); }

  /* boot */
  (async function boot() {
    try {
      const me = await api('GET', '/api/me');
      state.me = me.user; state.googleClientId = me.googleClientId; renderAccount();
      const [sample, health] = await Promise.all([api('GET', '/api/sample'), api('GET', '/api/health')]);
      state.sample = sample; state.llm = Boolean(health.llm);
      if (state.me.signedIn) {
        await refreshList();
        const id = remembered();
        const pick = state.list.find((r) => r.id === id) || state.list[0];
        if (pick) await openResume(pick.id).catch(() => remember(null));
      }
    } catch (e) { toast(`Could not reach the server: ${e.message}`); }
    route();
  })();
})();
