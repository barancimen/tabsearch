// Runs the embedding model away from the panel's page, so the panel stays
// responsive while tabs are embedded. The panel sends the model's files, then
// texts, and gets back one unit length vector per text.
import * as ort from './vendor/ort/ort.wasm.bundle.min.mjs'
import { Tokenizer } from './vendor/tokenizers/tokenizers.min.mjs'

ort.env.wasm.wasmPaths = new URL('vendor/ort/', import.meta.url).href
// several threads need a cross-origin isolated page, which the panel is not
ort.env.wasm.numThreads = 1

const MAX_TOKENS = 512 // the model's limit
const MAX_CHARS = 6000 // more than 512 tokens of English, so cutting here loses nothing

let session = null
let tokenizer = null

function tensor(values) {
  return new ort.Tensor('int64', BigInt64Array.from(values, (v) => BigInt(v)), [1, values.length])
}

async function embed(text) {
  let ids = tokenizer.encode(text.slice(0, MAX_CHARS)).ids
  // keep the closing [SEP] when cutting to the model's limit
  if (ids.length > MAX_TOKENS) ids = ids.slice(0, MAX_TOKENS - 1).concat(ids[ids.length - 1])
  const feeds = {
    input_ids: tensor(ids),
    attention_mask: tensor(ids.map(() => 1)),
  }
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0))
  const out = await session.run(feeds)
  let v
  if (out.sentence_embedding) {
    v = Float32Array.from(out.sentence_embedding.data)
  } else {
    // a model without its own pooling: average the token vectors
    const h = out.last_hidden_state
    const dim = h.dims[2]
    v = new Float32Array(dim)
    for (let t = 0; t < ids.length; t++) for (let i = 0; i < dim; i++) v[i] += h.data[t * dim + i] / ids.length
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') {
      tokenizer = new Tokenizer(m.tokenizer, m.tokenizerConfig)
      const options = { executionProviders: ['wasm'] }
      if (m.data) options.externalData = [{ path: m.dataName, data: new Uint8Array(m.data) }]
      session = await ort.InferenceSession.create(new Uint8Array(m.model), options)
      const probe = await embed('test')
      postMessage({ type: 'loaded', id: m.id, dims: probe.length })
    } else if (m.type === 'embed') {
      const vecs = []
      for (const text of m.texts) vecs.push(await embed(text))
      postMessage({ type: 'embedded', id: m.id, vecs }, vecs.map((v) => v.buffer))
    }
  } catch (e) {
    postMessage({ type: 'error', id: m.id, error: String((e && e.message) || e) })
  }
}
