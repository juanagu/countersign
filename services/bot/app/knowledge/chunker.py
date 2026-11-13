import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

import yaml
from pydantic import BaseModel

Audience = Literal["public", "customer"]

# Each `##` section is its own chunk, never merged, so a citation's heading and anchor name the section the
# text came from. Only a section over this size is split.
MAX_TOKENS = 600
# Rough Spanish ratio; the embedder truncates anyway, so this only shapes chunk sizes.
TOKENS_PER_WORD = 1.3


class KbDocMeta(BaseModel):
    id: str
    title: str
    audience: Audience


@dataclass(frozen=True)
class Chunk:
    doc_id: str
    title: str
    audience: Audience
    heading: str
    anchor: str
    content: str

    def embedding_text(self) -> str:
        return f"{self.title} — {self.heading}\n{self.content}"


def slugify(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")


def _tokens(text: str) -> int:
    return int(len(text.split()) * TOKENS_PER_WORD)


def parse_doc(text: str) -> tuple[KbDocMeta, str]:
    _, frontmatter, body = text.split("---", 2)
    return KbDocMeta.model_validate(yaml.safe_load(frontmatter)), body.strip()


def _sections(body: str, title: str) -> list[tuple[str, str]]:
    """Splits on `##` headings; text before the first heading belongs to the document title."""
    sections: list[tuple[str, str]] = []
    heading, lines = title, list[str]()
    for line in body.splitlines():
        if line.startswith("## "):
            if "\n".join(lines).strip():
                sections.append((heading, "\n".join(lines).strip()))
            heading, lines = line[3:].strip(), []
        elif not line.startswith("# "):
            lines.append(line)
    if "\n".join(lines).strip():
        sections.append((heading, "\n".join(lines).strip()))
    return sections


def _split_long(text: str) -> list[str]:
    """Splits an oversized section by paragraphs, repeating the last paragraph as overlap."""
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    parts: list[list[str]] = [[]]
    for paragraph in paragraphs:
        current = parts[-1]
        if current and _tokens("\n\n".join([*current, paragraph])) > MAX_TOKENS:
            parts.append([current[-1], paragraph])
        else:
            current.append(paragraph)
    return ["\n\n".join(part) for part in parts if part]


def chunk_doc(text: str) -> list[Chunk]:
    meta, body = parse_doc(text)
    return [
        Chunk(meta.id, meta.title, meta.audience, heading, slugify(heading), part)
        for heading, content in _sections(body, meta.title)
        for part in (_split_long(content) if _tokens(content) > MAX_TOKENS else [content])
    ]
