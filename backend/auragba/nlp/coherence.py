"""Semantic coherence between the digital-human prompt and the senior's answer.

This is the "does the reply actually track the question" biomarker — a drop in
coherence is an early signal of disorientation, independent of acoustics.

Back-ends:
  * `sentence-transformers` installed -> cosine similarity of sentence embeddings.
  * otherwise -> a deterministic lexical overlap (Jaccard + containment + length
    balance). No model download, no network.

`ponytail:` the lexical fallback has no semantic understanding — it scores shared
surface forms, not meaning. It is a placeholder with an honest ceiling, not a
substitute for the embedding model. Upgrade: `pip install sentence-transformers`,
the embedding path is used automatically (set AURA_COHERENCE_MODEL to a
Chinese-capable model).
"""

from __future__ import annotations

import os
import re

import numpy as np

from .metrics import tokenize

try:  # optional: real multilingual embeddings
    from sentence_transformers import SentenceTransformer  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    SentenceTransformer = None

_MODEL_NAME = os.getenv("AURA_COHERENCE_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")
_model = None
_model_failed = False
_PUNCT = re.compile(r"[^\w\u4e00-\u9fff]+")


def _embedding_model():
    global _model, _model_failed
    if SentenceTransformer is None or _model_failed:
        return None
    if _model is None:
        try:
            _model = SentenceTransformer(_MODEL_NAME)
        except Exception:  # pragma: no cover - model download / offline
            _model_failed = True
            return None
    return _model


def _lexical_overlap(question: str, answer: str) -> float:
    q_tokens, _ = tokenize(_PUNCT.sub(" ", question))
    a_tokens, _ = tokenize(_PUNCT.sub(" ", answer))
    q_set, a_set = set(q_tokens), set(a_tokens)
    if not q_set or not a_set:
        return 0.0
    jaccard = len(q_set & a_set) / len(q_set | a_set)
    containment = len(q_set & a_set) / len(q_set)
    length_balance = min(len(a_tokens), len(q_tokens)) / max(len(a_tokens), len(q_tokens))
    return float(np.clip(0.5 * jaccard + 0.35 * containment + 0.15 * length_balance, 0.0, 1.0))


def coherence(question: str, answer: str, locale: str = "zh-CN") -> float:
    """-> coherence score in [0, 1]; higher = the answer tracks the question.

    Returns 0.0 only when the answer is empty — an empty answer is not penalised
    as "incoherent" elsewhere in the pipeline, it is handled as missing data.
    """
    question = (question or "").strip()
    answer = (answer or "").strip()
    if not answer:
        return 0.0
    if not question:
        return 1.0  # nothing to be coherent with -> do not invent a penalty

    model = _embedding_model()
    if model is None:
        return _lexical_overlap(question, answer)
    try:
        vecs = model.encode([question, answer], normalize_embeddings=True)
        sim = float(np.dot(vecs[0], vecs[1]))
        return float(np.clip((sim + 1.0) / 2.0, 0.0, 1.0))  # [-1,1] -> [0,1]
    except Exception:  # pragma: no cover - encode failure
        return _lexical_overlap(question, answer)