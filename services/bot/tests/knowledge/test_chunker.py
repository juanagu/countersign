from itertools import pairwise

import pytest
from pydantic import ValidationError

from app.knowledge.chunker import MAX_TOKENS, TOKENS_PER_WORD, chunk_doc, slugify

DOC = """---
id: comisiones
title: Comisiones
audience: public
---
# Comisiones

Intro breve.

## Transferencias internacionales

Cuestan US$ 25 más 0,5 %.

## Mantenimiento de cuenta

La caja de ahorro es gratuita.
"""


def test_keeps_doc_metadata_and_anchors_on_every_chunk() -> None:
    chunks = chunk_doc(DOC)
    assert {c.doc_id for c in chunks} == {"comisiones"}
    assert all(c.audience == "public" for c in chunks)
    assert chunks[0].heading == "Comisiones"
    assert "Transferencias internacionales" in " ".join(c.content for c in chunks)


def test_merges_small_sections_into_one_chunk() -> None:
    assert len(chunk_doc(DOC)) == 1


def test_splits_an_oversized_section_with_paragraph_overlap() -> None:
    words_per_paragraph = int(MAX_TOKENS / TOKENS_PER_WORD / 3)
    paragraphs = [f"p{i} " + "palabra " * words_per_paragraph for i in range(6)]
    doc = "---\nid: largo\ntitle: Largo\naudience: customer\n---\n## Sección\n\n" + "\n\n".join(paragraphs)
    chunks = chunk_doc(doc)
    assert len(chunks) > 1
    for previous, current in pairwise(chunks):
        assert previous.content.split("\n\n")[-1] == current.content.split("\n\n")[0]
    assert all(c.anchor == "seccion" for c in chunks)


def test_rejects_an_unknown_audience() -> None:
    with pytest.raises(ValidationError):
        chunk_doc(DOC.replace("audience: public", "audience: staff"))


def test_slugify_strips_accents() -> None:
    assert slugify("Límites de Transferencia") == "limites-de-transferencia"
