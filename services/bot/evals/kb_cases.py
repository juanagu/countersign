"""Knowledge-base eval: the agent with only the knowledge skill, on the real model and the ingested KB.

Run with `make eval` (needs ANTHROPIC_API_KEY, `make up` and `make ingest`).
"""

import asyncio
import json
import re
import sys
from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool
from pydantic_ai.messages import ToolCallPart
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.config import Settings
from app.knowledge.embedder import FastEmbedEmbedder
from app.knowledge.search_tool import knowledge_toolset
from app.knowledge.store import PgKnowledgeStore
from app.skills.registry import SkillRegistry

MONEY = re.compile(r"(US\$|\$|ARS|USD)\s?\d")


@dataclass
class Contains(Evaluator[str, str]):
    needle: str

    def evaluate(self, ctx: EvaluatorContext[str, str]) -> bool:
        return self.needle.lower() in ctx.output.lower()


@dataclass
class Cites(Evaluator[str, str]):
    """The answer shows a Citation component naming the doc (the task appends render_ui arguments)."""

    doc_id: str

    def evaluate(self, ctx: EvaluatorContext[str, str]) -> bool:
        return '"Citation"' in ctx.output and f'"docId": "{self.doc_id}"' in ctx.output


@dataclass
class NoAmounts(Evaluator[str, str]):
    """An honest 'I don't know' must not slip in a figure."""

    def evaluate(self, ctx: EvaluatorContext[str, str]) -> bool:
        return MONEY.search(ctx.output) is None


DATASET = Dataset[str, str](
    name="knowledge-base",
    cases=[
        Case(
            name="scenario-1-international-transfer-fee",
            inputs="¿Cuánto cuesta una transferencia internacional?",
            evaluators=(Contains("US$ 25"), Contains("0,5"), Cites("comisiones")),
        ),
        Case(
            name="unanswerable-loan-rate",
            inputs="¿Qué tasa de interés tiene el préstamo personal a 24 meses?",
            evaluators=(Contains("no tengo esa información"), NoAmounts()),
        ),
        Case(
            name="unanswerable-crypto-fee",
            inputs="¿Cuánto cobran por comprar bitcoin desde la app?",
            evaluators=(Contains("no tengo esa información"), NoAmounts()),
        ),
    ],
)


async def main() -> int:
    settings = Settings()
    async with AsyncConnectionPool(settings.database_url, min_size=1, max_size=2, open=False) as pool:
        tools = knowledge_toolset(FastEmbedEmbedder(settings.embedding_model), PgKnowledgeStore(pool))
        skills = SkillRegistry.from_dir(settings.skills_dir)
        agent = build_agent(settings.bot_model, skills=skills, domain_tools=[tools])

        async def answer(question: str) -> str:
            result = await agent.run(question, deps=BotDeps(user_id="eval", access_token=""))
            ui_calls = [
                json.dumps(part.args_as_dict(), ensure_ascii=False)
                for message in result.all_messages()
                for part in getattr(message, "parts", [])
                if isinstance(part, ToolCallPart) and part.tool_name == "render_ui"
            ]
            return "\n".join([result.output, *ui_calls])

        report = await DATASET.evaluate(answer, max_concurrency=2)
    report.print(include_input=True, include_output=True)
    failed = [case.name for case in report.cases if not all(r.value for r in case.assertions.values())]
    return 1 if failed or report.failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
