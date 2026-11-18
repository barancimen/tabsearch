"""Computes mdbr-leaf-mt vectors for the test pages, for test/cluster.test.mjs.

The extension makes the same vectors in the browser; test/model.e2e.mjs checks
that they match. Needs Python with onnxruntime, tokenizers and numpy, and the
model folder (tokenizer.json, onnx/model_quantized.onnx and its _data file):

    python test/make-vectors.py /path/to/mdbr-leaf-mt
"""

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

HERE = Path(__file__).parent
MAX_TOKENS = 512
MAX_CHARS = 6000


def pages():
    """Every test page as (name, title, text, main), built as cluster.test.mjs builds them."""
    articles = json.loads((HERE / "fixtures" / "articles.json").read_text())["articles"]
    for name, body in articles.items():
        title = name + " - Wikipedia"
        text = title + "\nMain menu Navigation Search Donate Create account Log in\n" + body
        yield name, title, text, body
    social = json.loads((HERE / "fixtures" / "social.json").read_text())["pages"]
    for name, p in social.items():
        text = "\n".join([p["title"], p["nav"], p["article"], p["aside"], p["footer"]])
        yield name, p["title"], text, p["article"]


def model_input(title, text, main):
    """What the extension embeds for a tab (categories.js, embedInput)."""
    return (title + "\n" + (main or text))[:MAX_CHARS]


def main():
    folder = Path(sys.argv[1])
    tok = Tokenizer.from_file(str(folder / "tokenizer.json"))
    # tokenizer.json cuts at 128 tokens; the model reads 512, as the extension gives it
    tok.no_truncation()
    session = ort.InferenceSession(str(folder / "onnx" / "model_quantized.onnx"), providers=["CPUExecutionProvider"])
    out = {}
    for name, title, text, main_text in pages():
        ids = tok.encode(model_input(title, text, main_text)).ids
        if len(ids) > MAX_TOKENS:
            ids = ids[: MAX_TOKENS - 1] + ids[-1:]
        feed = {
            "input_ids": np.array([ids], dtype=np.int64),
            "attention_mask": np.ones((1, len(ids)), dtype=np.int64),
            "token_type_ids": np.zeros((1, len(ids)), dtype=np.int64),
        }
        v = session.run(["sentence_embedding"], feed)[0][0]
        v = v / np.linalg.norm(v)
        out[name] = [round(float(x), 5) for x in v]
    path = HERE / "fixtures" / "vectors.json"
    path.write_text(json.dumps({"model": "MongoDB/mdbr-leaf-mt onnx/model_quantized.onnx", "vectors": out}))
    print(f"{len(out)} vectors written to {path}")


if __name__ == "__main__":
    main()
