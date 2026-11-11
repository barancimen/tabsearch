'use strict'

// Groups tabs into topics from their text. Two tabs being in the same window
// only strengthens a resemblance their text already shows: tabs with nothing in
// common are never put together because of where they sit.
const Cluster = (() => {
  // Bump when terms() changes, so word counts saved by an older version are redone.
  const VERSION = 1
  const TITLE_WEIGHT = 3 // a title word counts as this many body words
  const KEEP_PER_DOC = 400 // most frequent terms kept from each page
  const VECTOR_TERMS = 100 // highest weighted terms that represent a page
  // Resemblance between tabs of one window is scaled by up to this much. Less
  // when most tabs share a window: then sharing one says little.
  const SAME_WINDOW = 1.5
  const JOIN = 0.02 // groups merge while their average resemblance is at least this
  const LABEL_TERMS = 3

  // Common English words, and words every website repeats, carry no topic.
  const STOP = new Set(
    `a about above across after again against all almost along already also although always am among an and
    another any anyone anything are aren't around as at away back be became because become becomes been before
    being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't done
    down during each either else enough etc even ever every few for from further get gets getting give given go
    goes going got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him
    himself his how how's however i i'd i'll i'm i've if in into is isn't it it's its itself just know last least
    less let let's like likely made make makes many may me might mine more most mostly much must mustn't my myself
    near need neither never new next no nor not now of off often on once one only onto or other others otherwise
    our ours ourselves out over own per perhaps put rather really said same say says see seen several shall
    shan't she she'd she'll she's should shouldn't show since so some something sometimes still such take than
    that that's the their theirs them themselves then there there's these they they'd they'll they're they've
    thing things this those though through thus to together too toward towards under until up upon us use used
    uses using very via was wasn't way we we'd we'll we're we've well were weren't what what's whatever when
    when's where where's whether which while who who's whom whose why why's will with within without won't would
    wouldn't yet you you'd you'll you're you've your yours yourself yourselves also first second third two three
    four five six seven eight nine ten hundred thousand million billion january february march april june july
    august september october november december monday tuesday wednesday thursday friday saturday sunday today
    yesterday tomorrow year years month months week weeks day days time times ago am pm
    account accept added agree all archive article articles back blog browser button cancel cart categories
    category chat check click close comment comments contact content continue cookie cookies copyright create
    details download edit email enable error faq feedback follow followers following footer free help home
    javascript join learn link links list loading log login logout main menu message messages more navigation
    newsletter notification notifications online open options page pages password policy post posted posts
    preferences previous privacy profile read related reply reserved rights save search section see select send
    settings share show sign site sitemap skip sort start submit subscribe support tab terms top topics updated
    upload user username users version video videos view views website welcome wikipedia www http https com org
    net html retrieved isbn doi pdf jpg png`.split(/\s+/)
  )

  // Everyday words count for less: they can still name a group, but they say
  // little about whether two pages share a subject.
  const GENERIC = new Set(
    `ability able absolute accept access accord according account achieve act action active activity actual actually add
    addition additional address advance advantage affect age agree agreement ahead aim allow almost alone alternative amount
    analysis announce annual answer anyway apart apparent appear application apply approach appropriate approximately area argue argument
    arrive aspect assume attempt attention available average avoid aware base based basic basis bear beat beautiful
    become begin beginning behind belief believe benefit best better big bit black blue break bring brought
    build building built call called came capable care carry case cause central century certain certainly chance
    change character charge choice choose claim class clear clearly close closely collection come comes coming common
    commonly compare comparison complete completely complex concern condition consider considerable considered consist constant contain context continue
    control core correct cost could country couple course cover current currently cut deal decade decide decision
    deep define degree deliver demand depend describe described design despite detail determine develop developed development difference
    different difficult direct direction directly discover discuss distinct divide document draw due early earlier easily easy
    effect effective effort element else emerge encourage end ensure entire entirely equal especially establish established estimate
    estimated event eventually evidence exact exactly example except exist existing expect experience explain express extend extent
    extra face fact factor fail fair fall false far fast feature feel field figure final finally
    find fine finish focus follow force form formal former forward found frequently full fully function fundamental
    general generally good great greater greatest ground group grow growth half hand happen hard head hear
    heavy held high higher highly hold huge human idea identify image impact importance important include included
    including increase increasingly indeed independent indicate individual influence information initial initially instead interest internal introduce introduced
    involve involved issue item keep key kind known lack large largely larger largest late later latter
    lead leading least leave led left length level likely limit limited line little live long longer
    look lose loss lot low lower main mainly maintain major majority manner mark material matter mean
    meaning means measure meet member mention method middle mind minor modern moment move movement name named
    narrow natural nature nearly necessary negative normal note notable noted number numerous object obtain obvious occur
    offer official old opportunity order ordinary original originally outside overall part particular particularly pass past people
    period person place plan play point popular position positive possible potential power practice prefer present pressure
    previous previously primary prior probably problem process produce produced production programme proper property propose provide provided
    purpose quality question quick quickly quite raise range rate reach real reason receive recent recently recognize
    record reduce refer reference reflect regard region regular relate related relation relationship relative relatively release released remain
    remove replace report represent require required response rest result return reveal right rise role rule run
    scale seem sense separate serious serve set short side significant significantly similar similarly simple simply single
    situation size small smaller social sometimes sort source space special specific specifically stage standard state stay
    step strong structure study subject success successful suggest suitable sum supply suppose sure system tend term
    test themselves therefore think thought total toward true try turn type typical typically understand unique unit
    unless unlike usual usually value variety various vary view visible whole wide widely word work world worth
    write written wrong`.split(/\s+/)
  )
  const GENERIC_WEIGHT = 0.3

  const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu
  const BREAK = /[^\s'"’“”‘-]/ // punctuation between two words ends a phrase

  // Folds plurals together: "papers" and "paper" become one term.
  function stem(w) {
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
    if (w.length > 3 && w.endsWith('s') && !/(ss|us|is|news)$/.test(w)) return w.slice(0, -1)
    return w
  }

  // A term from a word as written, or null for words that carry no topic.
  function term(raw) {
    const w = raw.replace(/’/g, "'").replace(/'s?$/, '')
    if (w.length < 2 || w.length > 30) return null
    // years and other numbers, and tokens like "1980s"
    const letters = (w.match(/\p{L}/gu) || []).length
    if (letters <= w.length - letters) return null
    // two letter words only as acronyms: AI, UK, EU
    if (w.length === 2 && w !== w.toUpperCase()) return null
    const lower = w.toLowerCase()
    if (STOP.has(lower)) return null
    return stem(lower)
  }

  // Counts words and two word phrases ("machine learning") into tf.
  function count(tf, text, weight) {
    let prev = null
    let end = 0
    const phrases = new Map()
    WORD.lastIndex = 0
    let m
    while ((m = WORD.exec(text))) {
      if (prev && m.index > end && BREAK.test(text.slice(end, m.index))) prev = null
      end = m.index + m[0].length
      const t = term(m[0])
      if (!t) {
        prev = null
        continue
      }
      tf.set(t, (tf.get(t) || 0) + (GENERIC.has(t) ? weight * GENERIC_WEIGHT : weight))
      if (prev && prev !== t) {
        const p = prev + ' ' + t
        phrases.set(p, (phrases.get(p) || 0) + weight)
      }
      prev = t
    }
    return phrases
  }

  // The terms of one page with their counts. Cached by the caller per tab.
  function terms(title, text, host) {
    const tf = new Map()
    const phrases = count(tf, title || '', TITLE_WEIGHT)
    for (const [p, n] of count(tf, text || '', 1)) phrases.set(p, (phrases.get(p) || 0) + n)
    // a phrase seen once is usually a coincidence of word order
    for (const [p, n] of phrases) if (n >= 2) tf.set(p, n)
    const kept = [...tf].sort((a, b) => b[1] - a[1]).slice(0, KEEP_PER_DOC)
    // the site helps a little: two pages on one site often share a subject
    if (host) kept.push(['@' + host.replace(/^www\./, ''), 1])
    return kept
  }

  // Weighted, unit length vectors: frequent in the page, rare across the tabs.
  function vectors(docs) {
    const df = new Map()
    for (const d of docs) for (const [t] of d.terms) df.set(t, (df.get(t) || 0) + 1)
    const n = docs.length
    return docs.map((d) => {
      let v = d.terms.map(([t, c]) => [t, (1 + Math.log(c)) * Math.log((n + 1) / (df.get(t) + 0.5))])
      v = v.filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, VECTOR_TERMS)
      const norm = Math.hypot(...v.map((x) => x[1])) || 1
      return new Map(v.map(([t, w]) => [t, w / norm]))
    })
  }

  // The share of tab pairs that are in the same window: 1 with a single window.
  function sharedWindow(docs) {
    const n = docs.length
    if (n < 2) return 1
    const per = new Map()
    for (const d of docs) per.set(d.windowId, (per.get(d.windowId) || 0) + 1)
    let same = 0
    for (const k of per.values()) same += k * (k - 1)
    return same / (n * (n - 1))
  }

  // How alike each pair of tabs is, from 0 to about 1.
  function similarity(docs, vecs) {
    const n = docs.length
    const sim = Array.from({ length: n }, () => new Float64Array(n))
    const postings = new Map()
    vecs.forEach((v, i) => {
      for (const [t, w] of v) {
        if (!postings.has(t)) postings.set(t, [])
        postings.get(t).push([i, w])
      }
    })
    for (const list of postings.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const x = list[a][1] * list[b][1]
          sim[list[a][0]][list[b][0]] += x
          sim[list[b][0]][list[a][0]] += x
        }
      }
    }
    const boost = 1 + (SAME_WINDOW - 1) * (1 - sharedWindow(docs))
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j && docs[i].windowId === docs[j].windowId) sim[i][j] *= boost
      }
    }
    return sim
  }

  // Average linkage: repeatedly join the two groups whose tabs are most alike on
  // average, until no two groups are alike enough.
  function link(sim) {
    const n = sim.length
    const groups = Array.from({ length: n }, (_, i) => [i])
    const c = sim.map((row) => Float64Array.from(row))
    const alive = new Set(groups.keys())
    for (;;) {
      let best = JOIN
      let bi = -1
      let bj = -1
      for (const i of alive) {
        for (const j of alive) {
          if (j <= i) continue
          if (c[i][j] >= best) {
            best = c[i][j]
            bi = i
            bj = j
          }
        }
      }
      if (bi < 0) break
      const ni = groups[bi].length
      const nj = groups[bj].length
      for (const k of alive) {
        if (k === bi || k === bj) continue
        c[bi][k] = c[k][bi] = (ni * c[bi][k] + nj * c[bj][k]) / (ni + nj)
      }
      groups[bi] = groups[bi].concat(groups[bj])
      alive.delete(bj)
    }
    return [...alive].map((i) => groups[i])
  }

  // Same word, or forms of one word: "italy" and "italian", "galaxy" and "galactic".
  function akin(a, b) {
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    return a === b || (i >= 4 && i >= 0.6 * Math.min(a.length, b.length))
  }

  // The terms that best describe a group: weighty in its tabs, shared by most
  // of them, and not just as weighty everywhere else.
  function keywords(members, vecs) {
    const inside = new Set(members)
    const score = new Map()
    const cover = new Map()
    for (const i of members) {
      for (const [t, w] of vecs[i]) {
        if (t[0] === '@') continue
        score.set(t, (score.get(t) || 0) + w)
        cover.set(t, (cover.get(t) || 0) + 1)
      }
    }
    const outside = new Map()
    const others = vecs.length - members.length
    if (others) {
      vecs.forEach((v, i) => {
        if (inside.has(i)) return
        for (const [t, w] of v) if (score.has(t)) outside.set(t, (outside.get(t) || 0) + w)
      })
    }
    const ranked = [...score]
      .map(([t, s]) => {
        const share = cover.get(t) / members.length
        let x = (s / members.length) * share - (others ? (outside.get(t) || 0) / others : 0)
        if (t.includes(' ')) x *= 1.25
        return [t, x]
      })
      .filter((x) => x[1] > 0)
      .sort((a, b) => b[1] - a[1])
    const picked = []
    for (const [t] of ranked) {
      if (picked.length >= LABEL_TERMS) break
      const words = t.split(' ')
      // "machine learning" makes "machine" and "learning" redundant, and "Italy" "Italian"
      if (picked.some((p) => p.split(' ').some((a) => words.some((b) => akin(a, b))))) continue
      picked.push(t)
    }
    return picked
  }

  // How a term is written in the pages, e.g. "GitHub" or "NASA" for "github".
  function display(t, texts) {
    const pattern = t
      .split(' ')
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .map((w) => (w.endsWith('y') ? w.slice(0, -1) + '(?:y|ies)' : w + '(?:e?s)?'))
      .join('[\\s-]+')
    const re = new RegExp('(?<![\\p{L}\\p{N}])' + pattern + '(?![\\p{L}\\p{N}])', 'iu')
    let found = ''
    for (const s of texts) {
      const m = re.exec(s)
      if (m) {
        found = m[0]
        break
      }
    }
    const w = found ? found.replace(/\s+/g, ' ') : t
    // all lowercase words get capitals; "iPhone" and "NASA" stay as they are
    return w === w.toLowerCase() ? w.replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase()) : w
  }

  // docs: [{ id, windowId, index, title, text, terms }] where terms comes from
  // terms(). Returns groups of two or more tabs, largest first, and the tabs
  // that resemble nothing else.
  function group(docs) {
    if (!docs.length) return { groups: [], rest: [] }
    const vecs = vectors(docs)
    const parts = link(similarity(docs, vecs))
    const order = (a, b) => docs[a].windowId - docs[b].windowId || docs[a].index - docs[b].index
    const groups = []
    const rest = []
    for (const p of parts) {
      p.sort(order)
      if (p.length < 2) {
        rest.push(docs[p[0]])
        continue
      }
      const keys = keywords(p, vecs)
      const titles = p.map((i) => docs[i].title || '')
      const words = keys.map((t) => display(t, titles.concat(p.map((i) => docs[i].text || ''))))
      groups.push({ tabs: p.map((i) => docs[i]), keywords: words, label: words.join(', ') })
    }
    groups.sort((a, b) => b.tabs.length - a.tabs.length || order(docs.indexOf(a.tabs[0]), docs.indexOf(b.tabs[0])))
    rest.sort((a, b) => a.windowId - b.windowId || a.index - b.index)
    return { groups, rest }
  }

  return { terms, group, vectors, similarity, SAME_WINDOW, JOIN, VERSION }
})()

if (typeof module === 'object' && module.exports) module.exports = Cluster
