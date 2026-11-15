from itertools import pairwise
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import KB_DIR
from app.knowledge.chunker import MAX_TOKENS, TOKENS_PER_WORD, chunk_doc, parse_doc, slugify

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


def test_keeps_doc_metadata_on_every_chunk() -> None:
    chunks = chunk_doc(DOC)
    assert {c.doc_id for c in chunks} == {"comisiones"}
    assert all(c.audience == "public" and c.title == "Comisiones" for c in chunks)


def test_every_section_is_its_own_chunk_with_its_own_heading_and_anchor() -> None:
    chunks = chunk_doc(DOC)
    assert [(c.heading, c.anchor, c.content) for c in chunks] == [
        ("Comisiones", "comisiones", "Intro breve."),
        ("Transferencias internacionales", "transferencias-internacionales", "Cuestan US$ 25 más 0,5 %."),
        ("Mantenimiento de cuenta", "mantenimiento-de-cuenta", "La caja de ahorro es gratuita."),
    ]


def test_a_doc_without_intro_starts_at_its_first_section() -> None:
    chunks = chunk_doc(DOC.replace("Intro breve.\n", ""))
    assert [c.heading for c in chunks] == ["Transferencias internacionales", "Mantenimiento de cuenta"]


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


def _sections_by_heading(path: Path) -> dict[str, str]:
    """An independent parse of a KB doc: heading → its text, the intro under the doc title."""
    meta, body = parse_doc(path.read_text(encoding="utf-8"))
    sections, heading = {meta.title: ""}, meta.title
    for line in body.splitlines():
        if line.startswith("## "):
            heading = line[3:].strip()
            sections[heading] = ""
        else:
            sections[heading] += line + "\n"
    return sections


@pytest.mark.parametrize("path", sorted(KB_DIR.glob("*.md")), ids=lambda p: p.stem)
def test_every_kb_chunk_belongs_to_its_own_heading(path: Path) -> None:
    sections = _sections_by_heading(path)
    chunks = chunk_doc(path.read_text(encoding="utf-8"))
    assert chunks
    for chunk in chunks:
        assert chunk.anchor == slugify(chunk.heading)
        for paragraph in chunk.content.split("\n\n"):
            assert paragraph in sections[chunk.heading], f"{chunk.anchor}: {paragraph[:40]!r}"
    # Every section with text has a chunk under its heading.
    assert {c.heading for c in chunks} == {h for h, text in sections.items() if text.strip()}
