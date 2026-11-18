'use strict'

// The embedding model the Categories view groups tabs with: MongoDB's
// mdbr-leaf-mt, read from a folder on this computer or downloaded once from
// Hugging Face into the extension's own storage. It runs in embed-worker.js.
const Model = (() => {
  const REPO = 'MongoDB/mdbr-leaf-mt'
  const REVISION = '1ed41b22ce166d66c24f88ebfc340e1f03adb20f' // fixed, so the files can't change
  const BASE = `https://huggingface.co/${REPO}/resolve/${REVISION}/`
  const CACHE = 'model-mdbr-leaf-mt'
  const DOWNLOAD = [
    ['tokenizer.json', 711661],
    ['tokenizer_config.json', 1529],
    ['onnx/model_quantized.onnx', 220168],
    ['onnx/model_quantized.onnx_data', 23049984],
  ]
  const DOWNLOAD_BYTES = DOWNLOAD.reduce((n, f) => n + f[1], 0)
  // the model file in a folder, best first; each may have its weights in NAME_data
  const MODEL_FILES = ['onnx/model_quantized.onnx', 'model_quantized.onnx', 'onnx/model.onnx', 'model.onnx']

  const M = {
    state: 'off', // off, loading, downloading, ready, error
    source: '', // folder or download
    folder: '',
    downloaded: false,
    error: '',
    key: '', // identifies the model, so vectors made by another one are not reused
    progress: 0, // bytes downloaded
    worker: null,
    calls: new Map(),
    nextId: 1,
    started: false,
    onchange: () => {},
  }

  function set(state, extra) {
    Object.assign(M, { state, error: '' }, extra)
    M.onchange()
  }

  function call(msg, transfer) {
    return new Promise((resolve, reject) => {
      const id = M.nextId++
      M.calls.set(id, { resolve, reject })
      M.worker.postMessage({ ...msg, id }, transfer || [])
    })
  }

  function startWorker() {
    stopWorker()
    M.worker = new Worker(chrome.runtime.getURL('embed-worker.js'), { type: 'module' })
    M.worker.onmessage = ({ data }) => {
      const c = M.calls.get(data.id)
      if (!c) return
      M.calls.delete(data.id)
      if (data.type === 'error') c.reject(new Error(data.error))
      else c.resolve(data)
    }
    M.worker.onerror = (e) => {
      for (const c of M.calls.values()) c.reject(new Error(e.message || 'the model stopped'))
      M.calls.clear()
    }
  }

  function stopWorker() {
    if (M.worker) M.worker.terminate()
    M.worker = null
    for (const c of M.calls.values()) c.reject(new Error('stopped'))
    M.calls.clear()
  }

  // A file as an ArrayBuffer, or null if it is not there. XHR because fetch
  // refuses file:// URLs.
  function read(url) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', url)
      xhr.responseType = 'arraybuffer'
      xhr.onload = () => resolve(xhr.status < 400 && xhr.response && xhr.response.byteLength ? xhr.response : null)
      xhr.onerror = () => resolve(null)
      xhr.send()
    })
  }

  // "/home/me/models/x", "~/x" is refused, "C:\models\x" works too
  function folderUrl(path) {
    let p = path.trim().replace(/\\/g, '/')
    if (/^file:\/\//i.test(p)) return p.replace(/\/*$/, '/')
    if (/^[a-z]:\//i.test(p)) p = '/' + p
    return 'file://' + p.split('/').map(encodeURIComponent).join('/').replace(/\/*$/, '/')
  }

  const json = (buf) => JSON.parse(new TextDecoder().decode(buf))

  // Starts the worker with the model's files. get(name) gives a file or null.
  async function boot(get, source) {
    const tok = await get('tokenizer.json')
    if (!tok) throw new Error('There is no tokenizer.json in it.')
    const tokConfig = await get('tokenizer_config.json')
    let name = ''
    let model = null
    for (const f of MODEL_FILES) {
      if ((model = await get(f))) {
        name = f
        break
      }
    }
    if (!model) throw new Error('There is no model in it. Expected onnx/model_quantized.onnx.')
    const data = await get(name + '_data')
    startWorker()
    const dataName = name.split('/').pop() + '_data'
    const transfer = [model].concat(data ? [data] : [])
    const sizes = model.byteLength + ':' + (data ? data.byteLength : 0)
    const r = await call(
      { type: 'load', tokenizer: json(tok), tokenizerConfig: tokConfig ? json(tokConfig) : {}, model, data, dataName },
      transfer
    )
    set('ready', { source, key: r.dims + ':' + sizes })
  }

  async function fromFolder(path) {
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
      throw new Error(
        'Chrome is not letting the extension read files. In chrome://extensions, open Details for ' +
          'Tab Text Search, turn on "Allow access to file URLs", and press Use folder again.'
      )
    }
    let base = folderUrl(path)
    // a Hugging Face download folder (models--MongoDB--mdbr-leaf-mt) holds its files in snapshots/
    if (!(await read(base + 'tokenizer.json'))) {
      const ref = await read(base + 'refs/main')
      if (ref) base += 'snapshots/' + new TextDecoder().decode(ref).trim() + '/'
    }
    if (!(await read(base + 'tokenizer.json')) && !(await read(base + 'config.json'))) {
      throw new Error('That folder was not found, or it is empty.')
    }
    await boot((name) => read(base + name), 'folder')
  }

  async function fromDownload() {
    const cache = await caches.open(CACHE)
    await boot(async (name) => {
      const r = await cache.match(BASE + name)
      return r ? r.arrayBuffer() : null
    }, 'download')
  }

  async function hasDownload() {
    try {
      const cache = await caches.open(CACHE)
      for (const [name] of DOWNLOAD) if (!(await cache.match(BASE + name))) return false
      return true
    } catch (e) {
      return false
    }
  }

  // Loads the model from the saved folder, or else from the download.
  async function load() {
    stopWorker()
    M.downloaded = await hasDownload()
    if (!M.folder && !M.downloaded) {
      set('off', { source: '', key: '' })
      return
    }
    set('loading', { source: M.folder ? 'folder' : 'download', key: '' })
    try {
      if (M.folder) await fromFolder(M.folder)
      else await fromDownload()
    } catch (e) {
      stopWorker()
      set('error', { key: '', error: (e && e.message) || String(e) })
    }
  }

  return {
    M,
    DOWNLOAD_BYTES,
    REPO,
    folderUrl,

    // Loads the model the first time the Categories view needs it.
    async start() {
      if (M.started) return
      M.started = true
      try {
        const { modelFolder } = await chrome.storage.local.get('modelFolder')
        M.folder = modelFolder || ''
      } catch (e) {}
      await load()
    },

    async useFolder(path) {
      M.folder = (path || '').trim()
      await chrome.storage.local.set({ modelFolder: M.folder }).catch(() => {})
      M.started = true
      await load()
    },

    // The folder was changed in another window's panel.
    async folderChanged(path) {
      if (!M.started || path === M.folder) return
      M.folder = path
      await load()
    },

    async download() {
      if (M.state === 'downloading') return
      stopWorker()
      set('downloading', { progress: 0, key: '' })
      try {
        const cache = await caches.open(CACHE)
        let done = 0
        for (const [name] of DOWNLOAD) {
          const url = BASE + name
          if (await cache.match(url)) {
            done += (await (await cache.match(url)).arrayBuffer()).byteLength
            continue
          }
          const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
          if (!res.ok) throw new Error('Hugging Face answered ' + res.status + ' for ' + name)
          const reader = res.body.getReader()
          const parts = []
          for (;;) {
            const { done: end, value } = await reader.read()
            if (end) break
            parts.push(value)
            done += value.byteLength
            M.progress = done
            M.onchange()
          }
          await cache.put(url, new Response(new Blob(parts)))
        }
        M.downloaded = true
      } catch (e) {
        set('error', { key: '', error: 'The download failed: ' + ((e && e.message) || e) })
        return
      }
      M.started = true
      await load()
    },

    async removeDownload() {
      try {
        await caches.delete(CACHE)
      } catch (e) {}
      M.downloaded = false
      if (M.source === 'download' || !M.folder) await load()
      else M.onchange()
    },

    // Unit length vectors for the texts, in order.
    async embed(texts) {
      if (M.state !== 'ready') throw new Error('the model is not ready')
      const r = await call({ type: 'embed', texts })
      return r.vecs
    },
  }
})()
