from app.knowledge.store import rrf_merge


def test_items_found_by_both_retrievers_rank_first() -> None:
    fused = rrf_merge([[1, 2, 3], [3, 4, 1]], k=4)
    assert [item for item, _ in fused][:2] == [1, 3]


def test_respects_k() -> None:
    assert len(rrf_merge([[1, 2, 3], [4, 5]], k=2)) == 2


def test_empty_rankings() -> None:
    assert rrf_merge([[], []], k=3) == []
