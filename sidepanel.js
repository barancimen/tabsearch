'use strict'

const $ = (id) => document.querySelector(id)
const Q = $('#q')
const DOMAIN = $('#dom')
const DOMS = $('#doms')
const RESULTS = $('#results')
const COUNT = $('#count')
const STATUS = $('#status')
const BAD = $('#bad')

const PER_TAB = 5 // snippets shown per tab
const MAX_GROUPS = 400 // tabs listed
const PAD = 80 // snippet context chars
const REFRESH_MS = 150 // repaints are coalesced to one per this interval

const S = {
  cache: new Map(), // tabId -> record
  failed: new Map(), // tabId -> why it could not be read
  badOpen: false,
  badKey: '',
  query: '',
  domain: '',
  mode: { cs: false, ww: false, re: false },
  indexing: false,
  done: 0,
  total: 0,
  refreshT: 0,
  run: 0,
  groups: [],
  flat: [], // one entry per rendered snippet
  rows: [],
  sel: -1,
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ESC[c])
}

function squash(s) {
  return s.replace(/\s+/g, ' ')
}

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function favicon(src) {
  if (!src) return el('span', 'fav ph')
  const img = new Image()
  img.className = 'fav'
  img.referrerPolicy = 'no-referrer'
  img.addEventListener('error', () => img.remove())
  img.src = src
  return img
}

function paintStatus(s) {
  STATUS.textContent = s
  BAD.hidden = true
}

function whyNot(t) {
  return canInject(t.url) ? S.failed.get(t.id) || '' : 'Restricted by Chrome'
}

function paintBad(bad) {
  BAD.hidden = !S.badOpen || !bad.length
  if (BAD.hidden) return
  const key = bad.map((t) => [t.id, t.url, t.title, whyNot(t)].join(' ')).join('\n')
  if (key === S.badKey) return
  S.badKey = key
  BAD.textContent = ''
  for (const t of bad) {
    const row = el('div', 'tabhead')
    const title = el('span', 'title', t.title || t.url)
    title.title = t.url || ''
    row.append(favicon(t.favIconUrl), title, el('span', 'why', whyNot(t)))
    row.addEventListener('click', () => focusTab({ windowId: t.windowId, tabId: t.id }))
    BAD.append(row)
  }
}

async function paintSummary() {
  let bad = []
  try {
    const tabs = await chrome.tabs.query({})
    bad = tabs.filter((t) => t.id != null && whyNot(t))
  } catch (e) {}
  STATUS.textContent = S.cache.size + ' tabs indexed' + (bad.length ? ', ' : '')
  if (bad.length) {
    const btn = el('button', '', bad.length + ' not searchable')
    btn.type = 'button'
    btn.setAttribute('aria-expanded', String(S.badOpen))
    btn.addEventListener('click', () => {
      S.badOpen = !S.badOpen
      paintSummary()
    })
    STATUS.append(btn)
  }
  paintBad(bad)
}

function paintCount(s) {
  COUNT.textContent = s
}

// Tabs this extension is allowed to read. Everything else (chrome://, the Web
// Store, other extensions, devtools, view-source, PDF viewer) is unreachable.
const BLOCKED = /^(chrome|chrome-untrusted|edge|brave|about|devtools|view-source|chrome-extension|moz-extension|data|blob):/

function canInject(url) {
  if (!url || BLOCKED.test(url)) return false
  if (url.startsWith('https://chrome.google.com/webstore')) return false
  return /^(https?|file|ftp):/.test(url)
}

function hostsOf(url) {
  try {
    const u = new URL(url)
    return { host: u.host.toLowerCase(), hostname: u.hostname.toLowerCase() }
  } catch (e) {
    return { host: '', hostname: '' }
  }
}

// Accepts "x.com", "*.x.com", "www.x.com", "https://x.com/home", "x.com:8443".
function normDomain(raw) {
  let s = String(raw || '').trim().toLowerCase()
  if (!s) return ''
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  s = s.split(/[/?#]/)[0]
  s = s.replace(/^\*\./, '').replace(/^www\./, '')
  return s.replace(/\.+$/, '')
}

// "x.com" covers x.com and any subdomain. Compare against both the host and the
// hostname so an explicit port narrows the match and an IPv6 literal still works.
function domMatch(rec, f) {
  if (!f) return true
  for (const h of [rec.hostname, rec.host]) {
    if (h && (h === f || h.endsWith('.' + f))) return true
  }
  return false
}

/* Runs inside each page and each of its frames. Self contained. */
function extract() {
  const parts = []
  if (document.title) parts.push(document.title)
  const meta = document.querySelector('meta[name="description"]')
  if (meta && meta.content) parts.push(meta.content)
  if (document.body) {
    const SKIP = 'script,style,noscript,template'
    const skip = new Set(SKIP.split(','))
    // Elements inside a skipped element are rare, and only they need the slow ancestor check.
    const nested = document.body.querySelector('script *,style *,noscript *,template *')
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION
    )
    const chunks = []
    let n
    while ((n = walker.nextNode())) {
      const p = n.parentElement
      if (nested ? !p.closest(SKIP) : !skip.has(p.localName)) chunks.push(n.data)
    }
    const t = chunks.join('').replace(/\s+/g, ' ').trim()
    if (t) parts.push(t)
  }
  for (const f of document.querySelectorAll('input,textarea')) {
    if (f.type === 'password') continue
    const v = f.value
    if (typeof v === 'string' && v) parts.push(v)
  }
  return {
    url: location.href,
    text: parts.join('\n'),
    // true in Chrome's viewer and in viewers that sit on top of it, like Scholar's
    pdf: document.contentType === 'application/pdf',
  }
}

function forget(id, why) {
  S.cache.delete(id)
  S.failed.set(id, why)
  dbDel(id)
}

// XHR because fetch refuses file:// URLs.
function download(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'arraybuffer'
    xhr.withCredentials = true
    xhr.onload = () => (xhr.status < 400 ? resolve(xhr.response) : reject(new Error(xhr.status)))
    xhr.onerror = () => reject(new Error('network'))
    xhr.send()
  })
}

let pdfjs

// Loaded on first use. Every PDF shares one worker instead of starting its own.
function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = import('./vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs')
      return { lib, worker: new lib.PDFWorker() }
    })
  }
  return pdfjs
}

async function readPdf(url) {
  const data = new Uint8Array(await download(url))
  const { lib, worker } = await loadPdfjs()
  const task = lib.getDocument({
    data,
    worker,
    cMapUrl: chrome.runtime.getURL('vendor/pdfjs/cmaps/'),
    cMapPacked: true,
    isEvalSupported: false,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const { items } = await page.getTextContent()
      pages.push(items.map((x) => (x.str || '') + (x.hasEOL ? ' ' : '')).join(''))
      page.cleanup()
    }
    return squash(pages.join(' ')).trim()
  } finally {
    await task.destroy()
  }
}

async function readTab(t) {
  if (t.id == null || !canInject(t.url)) return
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: t.id, allFrames: true },
      func: extract,
    })
    let pdfFailed = false
    const parts = await Promise.all(
      res.map(async (r) => {
        const v = r && r.result
        if (!v || !v.pdf) return v && v.text
        try {
          const body = await readPdf(v.url)
          return body && (t.title ? t.title + '\n' + body : body)
        } catch (e) {
          pdfFailed = true
        }
      })
    )
    const text = parts.filter(Boolean).join('\n')
    if (!text) {
      forget(t.id, pdfFailed ? 'PDF could not be read' : 'No text found')
      return
    }
    const rec = {
      tabId: t.id,
      windowId: t.windowId,
      index: t.index || 0,
      title: t.title || '',
      url: t.url || '',
      fav: t.favIconUrl || '',
      ...hostsOf(t.url),
      text,
      hits: 0,
    }
    S.cache.set(t.id, rec)
    S.failed.delete(t.id)
    if (!t.incognito) dbPut(rec)
  } catch (e) {
    forget(t.id, t.discarded || t.status === 'unloaded' ? 'Not loaded' : 'Could not be read')
  }
}

// Loads the saved index and returns the tabs it does not cover.
async function restore(targets) {
  let saved = []
  try {
    saved = await dbAll()
  } catch (e) {}
  const live = new Map(targets.map((t) => [t.id, t]))
  for (const rec of saved) {
    const t = live.get(rec.tabId)
    if (!t || t.url !== rec.url) {
      dbDel(rec.tabId)
      continue
    }
    // a tab that finished loading while this ran has fresher text already
    if (S.cache.has(t.id)) continue
    S.cache.set(t.id, {
      ...rec,
      windowId: t.windowId,
      index: t.index || 0,
      title: t.title || '',
      fav: t.favIconUrl || '',
    })
  }
  return targets.filter((t) => !S.cache.has(t.id))
}

function refresh() {
  if (S.refreshT) return
  S.refreshT = setTimeout(() => {
    S.refreshT = 0
    if (S.indexing) paintStatus('Indexing ' + S.done + '/' + S.total)
    else paintSummary()
    paintDomains()
    if (S.query) runSearch()
  }, REFRESH_MS)
}

async function indexAll(full) {
  if (S.indexing) return
  S.indexing = true
  const run = ++S.run
  if (full) {
    S.cache.clear()
    S.failed.clear()
  }
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id != null)
  const targets = tabs.filter((t) => canInject(t.url))
  const todo = full ? targets : await restore(targets)
  if (run !== S.run) return
  S.done = 0
  S.total = todo.length
  paintStatus('Indexing 0/' + todo.length)
  paintDomains()
  if (S.query) runSearch()
  // All at once and not in batches, so a slow tab only ever delays itself.
  await Promise.all(
    todo.map(async (t) => {
      await readTab(t)
      if (run !== S.run) return
      S.done++
      refresh()
    })
  )
  if (run !== S.run) return
  S.indexing = false
  await paintSummary()
  paintDomains()
  if (S.query) runSearch()
}

function buildRe(q, m) {
  let src = m.re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (m.ww) src = '\\b(?:' + src + ')\\b'
  return new RegExp(src, m.cs ? 'g' : 'gi')
}

function runSearch() {
  const q = S.query
  const min = S.mode.re ? 1 : 2
  if (q.length < min) {
    S.groups = []
    paint()
    paintCount('')
    return
  }
  let re
  try {
    re = buildRe(q, S.mode)
  } catch (e) {
    S.groups = []
    S.flat = []
    S.rows = []
    S.sel = -1
    RESULTS.textContent = ''
    RESULTS.append(el('div', 'empty', 'Invalid regular expression.'))
    paintCount('Invalid pattern')
    return
  }
  const groups = []
  const domain = S.domain
  for (const rec of S.cache.values()) {
    if (groups.length >= MAX_GROUPS) break
    if (domain && !domMatch(rec, domain)) continue
    re.lastIndex = 0
    const hits = []
    let total = 0
    let m
    while ((m = re.exec(rec.text))) {
      total++
      if (hits.length < PER_TAB) hits.push({ i: m.index, len: m[0].length })
      if (m[0].length === 0) re.lastIndex++
      if (total >= 5000) break
    }
    rec.hits = total
    if (total) groups.push({ rec, hits, total })
  }
  groups.sort(
    (a, b) => b.total - a.total || a.rec.windowId - b.rec.windowId || a.rec.index - b.rec.index
  )
  S.groups = groups
  paint()
}

function snippet(text, i, len) {
  const a = text.slice(Math.max(0, i - PAD), i)
  let mid = text.slice(i, i + len)
  const c = text.slice(i + len, i + len + PAD)
  let clipped = false
  if (mid.length > 160) {
    mid = mid.slice(0, 160)
    clipped = true
  }
  const lead = i > PAD ? '…' : ''
  const tail = i + len + PAD < text.length ? '…' : ''
  return (
    lead +
    esc(squash(a).trimStart()) +
    '<mark>' +
    esc(squash(mid)) +
    (clipped ? '…' : '') +
    '</mark>' +
    esc(squash(c).trimEnd()) +
    tail
  )
}

function paintDomains() {
  const seen = new Set()
  for (const r of S.cache.values()) if (r.hostname) seen.add(r.hostname)
  DOMS.textContent = ''
  for (const h of [...seen].sort()) {
    const opt = document.createElement('option')
    opt.value = h
    DOMS.append(opt)
  }
}

function paint() {
  RESULTS.textContent = ''
  S.flat = []
  S.rows = []
  S.sel = -1
  const groups = S.groups
  if (!S.query || S.query.length < (S.mode.re ? 1 : 2)) {
    RESULTS.append(el('div', 'empty', 'Type to search the text of every open tab.'))
    return
  }
  if (!groups.length) {
    if (S.domain) {
      const inScope = [...S.cache.values()].filter((r) => domMatch(r, S.domain)).length
      RESULTS.append(
        el(
          'div',
          'empty',
          inScope
            ? 'No matches in ' + inScope + ' tabs on ' + S.domain + '.'
            : 'No open tab matches ' + S.domain + '.'
        )
      )
    } else {
      RESULTS.append(el('div', 'empty', 'No matches in ' + S.cache.size + ' indexed tabs.'))
    }
    paintCount('0 matches')
    return
  }
  const frag = document.createDocumentFragment()
  let shown = 0
  for (const g of groups) {
    const sec = el('section', 'group')
    const head = el('div', 'tabhead')
    head.append(favicon(g.rec.fav))
    const title = el('span', 'title', g.rec.title || g.rec.url)
    title.title = g.rec.url
    head.append(title, el('span', 'badge', String(g.total)))
    head.addEventListener('click', () => focusTab(g.rec))
    sec.append(head)
    for (const h of g.hits) {
      const row = el('div', 'hit')
      row.innerHTML = snippet(g.rec.text, h.i, h.len)
      const idx = S.flat.length
      S.flat.push({ rec: g.rec, hit: h })
      S.rows.push(row)
      row.addEventListener('click', () => jump(idx))
      sec.append(row)
      shown++
    }
    if (g.total > g.hits.length) {
      sec.append(el('div', 'more', '+' + (g.total - g.hits.length) + ' more in this tab'))
    }
    frag.append(sec)
  }
  RESULTS.append(frag)
  paintCount(
    shown +
      ' matches in ' +
      groups.length +
      ' tabs' +
      (S.domain ? ' on ' + S.domain : '') +
      (groups.length >= MAX_GROUPS ? ' (capped)' : '')
  )
}

function focusTab(rec) {
  chrome.windows.update(rec.windowId, { focused: true }).catch(() => {})
  chrome.tabs.update(rec.tabId, { active: true }).catch(() => {})
}

/* Runs in the page: reveal the match using the browser's own find. */
function findText(cands, cs) {
  try {
    if (typeof window.find !== 'function') return false
    for (const t of cands) {
      if (t && window.find(t, cs, false, true, false, false)) return true
    }
  } catch (e) {}
  return false
}

function candidates(rec, hit) {
  const raw = rec.text.slice(hit.i, hit.i + Math.min(hit.len || 0, 200)).trim()
  const out = []
  if (raw && raw.length <= 120) out.push(raw)
  const toks = raw
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length)
  for (const t of toks) if (!out.includes(t)) out.push(t)
  if (!out.length) out.push(S.query)
  return out.slice(0, 4)
}

async function jump(idx) {
  const e = S.flat[idx]
  if (!e) return
  focusTab(e.rec)
  const args = [candidates(e.rec, e.hit), S.mode.cs]
  let ok = false
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: e.rec.tabId },
      func: findText,
      args,
    })
    ok = r.some((x) => x && x.result)
  } catch (err) {}
  if (ok) return
  try {
    await chrome.scripting.executeScript({
      target: { tabId: e.rec.tabId, allFrames: true },
      func: findText,
      args,
    })
  } catch (err) {}
}

function select() {
  for (let i = 0; i < S.rows.length; i++) S.rows[i].classList.toggle('sel', i === S.sel)
  if (S.sel >= 0) S.rows[S.sel].scrollIntoView({ block: 'nearest' })
}

Q.addEventListener('input', () => {
  clearTimeout(Q._t)
  const go = () => {
    S.query = Q.value
    runSearch()
  }
  if (!Q.value) go()
  else Q._t = setTimeout(go, 120)
})

DOMAIN.addEventListener('input', () => {
  clearTimeout(DOMAIN._t)
  const go = () => {
    S.domain = normDomain(DOMAIN.value)
    runSearch()
  }
  if (!DOMAIN.value) go()
  else DOMAIN._t = setTimeout(go, 120)
})

for (const [key, id] of [
  ['cs', '#cs'],
  ['ww', '#ww'],
  ['re', '#re'],
]) {
  const btn = $(id)
  btn.addEventListener('click', () => {
    S.mode[key] = !S.mode[key]
    btn.classList.toggle('on', S.mode[key])
    chrome.storage.local.set({ mode: S.mode }).catch(() => {})
    runSearch()
  })
}

$('#refresh').addEventListener('click', () => {
  S.run++
  S.indexing = false
  indexAll(true)
})

document.addEventListener('keydown', (e) => {
  if (e.target === DOMAIN || e.target.closest('#status')) return
  if (e.key === 'Enter' && S.flat.length) {
    e.preventDefault()
    jump(S.sel >= 0 ? S.sel : 0)
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if (!S.flat.length) return
  e.preventDefault()
  if (e.key === 'ArrowDown') S.sel = Math.min(S.flat.length - 1, S.sel + 1)
  else S.sel = Math.max(0, S.sel - 1)
  select()
})

chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url) {
    S.cache.delete(id)
    S.failed.delete(id)
  }
  if (info.status !== 'complete') return
  readTab(tab).then(refresh)
})

chrome.tabs.onRemoved.addListener((id) => {
  S.cache.delete(id)
  S.failed.delete(id)
  refresh()
})

;(async function init() {
  try {
    const { mode } = await chrome.storage.local.get('mode')
    if (mode) {
      Object.assign(S.mode, mode)
      for (const k of ['cs', 'ww', 're']) $('#' + k).classList.toggle('on', !!S.mode[k])
    }
  } catch (e) {}
  Q.focus()
  paint()
  await indexAll()
})()
