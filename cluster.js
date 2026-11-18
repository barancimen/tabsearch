'use strict'

// Groups tabs by subject, at two levels: categories, and subgroups inside them.
// Tabs are compared by meaning when every tab has a vector from the embedding
// model (model.js), and otherwise by the words they share. Two tabs being in the
// same window only nudges a resemblance their content already shows.
const Cluster = (() => {
  // Bump when terms() changes, so word counts saved by an older version are redone.
  const VERSION = 3
  const TITLE_WEIGHT = 3 // a title word counts as this many body words
  const GENERIC_WEIGHT = 0.3 // an everyday word (GENERIC below) counts this much of a word
  const KEEP_PER_DOC = 400 // most frequent terms kept from each page
  const VECTOR_TERMS = 100 // highest weighted terms that represent a page
  const PHRASE_BONUS = 1.25 // a two word phrase is preferred this much in a name
  const PHRASE_OVER_WORD = 0.5 // a phrase scoring this share of its word's score names the group instead
  // Two tabs this alike are the same page, or nearly.
  const SAME_PAGE = { meaning: 0.97, words: 0.9 }

  // The settings group() takes, which the panel's sliders change. Meaning and
  // words measure resemblance on different scales, so each has its own.
  const DEFAULTS = {
    meaning: {
      category: 0.45, // tabs join a category while their average resemblance is at least this
      subgroup: 0.62, // and a subgroup within it at this
      window: 0.05, // tabs of one window count as up to this much more alike (0.05 is 5%)
      labelTerms: 3, // words in a name
    },
    words: { category: 0.02, subgroup: 0.08, window: 0.05, labelTerms: 3 },
  }

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
    net html retrieved isbn doi pdf jpg png
    repost reposts likes bookmark bookmarks replies replying upvote upvotes downvote award awards subscribed
    subscriber subscribers trending autoplay watching hr hrs min mins`.split(/\s+/)
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

  // Counts words into tf, and returns the counts of two word phrases ("machine learning").
  function count(tf, text) {
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
      tf.set(t, (tf.get(t) || 0) + 1)
      if (prev && prev !== t) {
        const p = prev + ' ' + t
        phrases.set(p, (phrases.get(p) || 0) + 1)
      }
      prev = t
    }
    return phrases
  }

  // How much a term [term, times in the text, times in the title] counts in its page.
  function weight([t, body, title]) {
    const c = body + TITLE_WEIGHT * (title || 0)
    return GENERIC.has(t) ? c * GENERIC_WEIGHT : c
  }

  // The terms of one page, as [term, times in the text, times in the title].
  // Cached by the caller per tab.
  function terms(title, text) {
    const inTitle = new Map()
    const inText = new Map()
    const titlePhrases = count(inTitle, title || '')
    const textPhrases = count(inText, text || '')
    const all = new Map()
    for (const [t, n] of inText) all.set(t, [t, n, 0])
    for (const [t, n] of inTitle) {
      if (all.has(t)) all.get(t)[2] = n
      else all.set(t, [t, 0, n])
    }
    for (const ph of new Set([...titlePhrases.keys(), ...textPhrases.keys()])) {
      const e = [ph, textPhrases.get(ph) || 0, titlePhrases.get(ph) || 0]
      // a phrase seen once is usually a coincidence of word order
      if (weight(e) >= 2) all.set(ph, e)
    }
    return [...all.values()].sort((a, b) => weight(b) - weight(a)).slice(0, KEEP_PER_DOC)
  }

  // Weighted, unit length word vectors: frequent in the page, rare across the tabs.
  function vectors(docs) {
    const df = new Map()
    for (const d of docs) for (const [t] of d.terms) df.set(t, (df.get(t) || 0) + 1)
    const n = docs.length
    return docs.map((d) => {
      let v = []
      for (const e of d.terms) {
        const c = weight(e)
        if (c > 0) v.push([e[0], (1 + Math.log(c)) * Math.log((n + 1) / (df.get(e[0]) + 0.5))])
      }
      v = v.filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, VECTOR_TERMS)
      const norm = Math.hypot(...v.map((x) => x[1])) || 1
      return new Map(v.map(([t, w]) => [t, w / norm]))
    })
  }

  // Cosine similarity of the word vectors, from postings lists.
  function wordSimilarity(vecs) {
    const n = vecs.length
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
    return sim
  }

  // Cosine similarity of the model's unit length vectors.
  function meaningSimilarity(docs) {
    const n = docs.length
    const sim = Array.from({ length: n }, () => new Float64Array(n))
    for (let i = 0; i < n; i++) {
      const a = docs[i].vec
      for (let j = i + 1; j < n; j++) {
        const b = docs[j].vec
        let x = 0
        for (let k = 0; k < a.length; k++) x += a[k] * b[k]
        sim[i][j] = sim[j][i] = x
      }
    }
    return sim
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

  // Tabs of one window count as up to `share` more alike. Less when most tabs
  // share a window, as then sharing one says little. Only a resemblance above
  // zero grows, so tabs with nothing in common stay apart.
  function nudge(raw, docs, share) {
    const boost = 1 + share * (1 - sharedWindow(docs))
    return raw.map((row, i) =>
      row.map((x, j) => (i !== j && x > 0 && docs[i].windowId === docs[j].windowId ? x * boost : x))
    )
  }

  // Average linkage: repeatedly join the two groups whose tabs are most alike
  // on average. Returns the groups as they stand when the best join falls below
  // each threshold, highest threshold first, so each level splits the next.
  function link(sim, thresholds) {
    const n = sim.length
    const groups = Array.from({ length: n }, (_, i) => [i])
    const c = sim.map((row) => Float64Array.from(row))
    const alive = new Set(groups.keys())
    const levels = []
    for (const limit of [...thresholds].sort((a, b) => b - a)) {
      for (;;) {
        let best = limit
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
      levels.push([...alive].map((i) => groups[i].slice()))
    }
    return levels
  }

  // Same word, or forms of one word: "italy" and "italian", "galaxy" and "galactic".
  function akin(a, b) {
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    return a === b || (i >= 4 && i >= 0.6 * Math.min(a.length, b.length))
  }

  // The terms that best describe a group of tabs: weighty in its tabs, shared
  // by most of them, and not as weighty in the tabs it is set against.
  // Terms akin to any in `avoid` are skipped.
  function keywords(members, others, vecs, count, avoid = []) {
    const score = new Map()
    const cover = new Map()
    for (const i of members) {
      for (const [t, w] of vecs[i]) {
        score.set(t, (score.get(t) || 0) + w)
        cover.set(t, (cover.get(t) || 0) + 1)
      }
    }
    const outside = new Map()
    for (const i of others) {
      for (const [t, w] of vecs[i]) if (score.has(t)) outside.set(t, (outside.get(t) || 0) + w)
    }
    const ranked = [...score]
      .map(([t, s]) => {
        const share = cover.get(t) / members.length
        let x = (s / members.length) * share - (others.length ? (outside.get(t) || 0) / others.length : 0)
        if (t.includes(' ')) x *= PHRASE_BONUS
        return [t, x]
      })
      .filter((x) => x[1] > 0)
      .sort((a, b) => b[1] - a[1])
    const picked = []
    const taken = avoid.slice()
    for (let [t, x] of ranked) {
      if (picked.length >= count) break
      // "black hole" rather than "hole", when the phrase scores nearly as well
      if (!t.includes(' ')) {
        const phrase = ranked.find(([u, y]) => y >= PHRASE_OVER_WORD * x && u.split(' ').includes(t) && u !== t)
        if (phrase) t = phrase[0]
      }
      const words = t.split(' ')
      // "machine learning" makes "machine" and "learning" redundant, and "Italy" "Italian"
      if (taken.some((p) => p.split(' ').some((a) => words.some((b) => akin(a, b))))) continue
      picked.push(t)
      taken.push(t)
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

  // Settings for one way of measuring, with anything missing or out of place
  // taken from DEFAULTS.
  function settings(mode, given) {
    const p = { ...DEFAULTS[mode] }
    for (const k in p) {
      const v = given && given[k]
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) p[k] = v
    }
    p.labelTerms = Math.max(1, Math.round(p.labelTerms))
    // a subgroup is never looser than its category
    p.subgroup = Math.max(p.subgroup, p.category)
    return p
  }

  // The page address without its #fragment, for spotting the same page twice.
  const pageOf = (url) => (url || '').replace(/#.*$/, '')

  // docs: [{ id, windowId, index, title, text, terms, url, vec, skip }] where
  // terms comes from terms() and vec, if every doc has one, from the model.
  // Docs with skip set (browser pages with no text) are only listed as unlike
  // the others.
  // given: { meaning: {...}, words: {...} } settings that differ from DEFAULTS.
  // Returns the categories, largest first, each with its subgroups and the
  // tabs in no subgroup; the tabs like no other; and for each tab that has
  // duplicates, the ids of those.
  function group(all, given) {
    const skipped = all.filter((d) => d.skip)
    const docs = all.filter((d) => !d.skip)
    const mode = docs.length && docs.every((d) => d.vec && d.vec.length) ? 'meaning' : 'words'
    if (!docs.length) return { mode, categories: [], rest: skipped, duplicates: new Map() }
    const p = settings(mode, given && given[mode])
    const vecs = vectors(docs)
    const raw = mode === 'meaning' ? meaningSimilarity(docs) : wordSimilarity(vecs)
    const [fine, coarse] = link(nudge(raw, docs, p.window), [p.subgroup, p.category])
    const duplicates = new Map()
    const copy = new Set() // tabs that repeat a page an earlier tab has open
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const same = (docs[i].url && pageOf(docs[i].url) === pageOf(docs[j].url)) || raw[i][j] >= SAME_PAGE[mode]
        if (!same) continue
        copy.add(j)
        for (const [a, b] of [[i, j], [j, i]]) {
          if (!duplicates.has(docs[a].id)) duplicates.set(docs[a].id, [])
          duplicates.get(docs[a].id).push(docs[b].id)
        }
      }
    }
    // a page open twice counts once in names
    const once = (ids) => (ids.some((i) => !copy.has(i)) ? ids.filter((i) => !copy.has(i)) : ids)

    const order = (a, b) => docs[a].windowId - docs[b].windowId || docs[a].index - docs[b].index
    const texts = (ids) => ids.map((i) => docs[i].title || '').concat(ids.map((i) => docs[i].text || ''))
    const name = (keys, ids) => keys.map((t) => display(t, texts(ids)))
    const everyone = docs.map((_, i) => i)

    const categories = []
    const rest = []
    for (const part of coarse) {
      part.sort(order)
      if (part.length < 2) {
        rest.push(docs[part[0]])
        continue
      }
      const inside = new Set(part)
      const keys = keywords(once(part), once(everyone.filter((i) => !inside.has(i))), vecs, p.labelTerms)
      const words = name(keys, part)
      let subs = fine.filter((s) => s.length >= 2 && s.length < part.length && inside.has(s[0]))
      // one subgroup and a few strays is not a split worth showing
      if (subs.length < 2) subs = []
      const inSub = new Set(subs.flat())
      const subgroups = subs
        .map((s) => {
          s.sort(order)
          const own = new Set(s)
          const k = keywords(once(s), once(part.filter((i) => !own.has(i))), vecs, p.labelTerms, keys)
          const w = name(k, s)
          return { tabs: s.map((i) => docs[i]), keywords: w, label: w.join(', ') }
        })
        .sort((a, b) => b.tabs.length - a.tabs.length || order(docs.indexOf(a.tabs[0]), docs.indexOf(b.tabs[0])))
      categories.push({
        tabs: part.map((i) => docs[i]),
        keywords: words,
        label: words.join(', '),
        subgroups,
        loose: part.filter((i) => !inSub.has(i)).map((i) => docs[i]),
      })
    }
    categories.sort((a, b) => b.tabs.length - a.tabs.length || order(docs.indexOf(a.tabs[0]), docs.indexOf(b.tabs[0])))
    rest.push(...skipped)
    rest.sort((a, b) => a.windowId - b.windowId || a.index - b.index)

    return { mode, categories, rest, duplicates }
  }

  return { terms, group, vectors, settings, link, DEFAULTS, VERSION }
})()

if (typeof module === 'object' && module.exports) module.exports = Cluster
