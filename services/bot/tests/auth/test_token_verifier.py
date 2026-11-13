import time
from typing import Any

import httpx
import jwt
import pytest

from app.auth.token_verifier import (
    BOT_AUDIENCE,
    InvalidTokenError,
    JwksTokenVerifier,
    JwksUnavailableError,
    http_jwks_fetcher,
)
from tests.conftest import ISSUER, SigningKey


async def test_accepts_a_valid_bot_token(verifier: JwksTokenVerifier, signing_key: SigningKey) -> None:
    principal = await verifier.verify(signing_key.token())
    assert principal.user_id == "ana"


def _expired() -> dict[str, Any]:
    now = int(time.time())
    return {"iat": now - 600, "exp": now - 300}


@pytest.mark.parametrize(
    "overrides",
    [
        pytest.param({"aud": "bff"}, id="session token (aud=bff)"),
        pytest.param({"aud": "mcp-accounts"}, id="token for another audience"),
        pytest.param({"iss": "http://evil.test"}, id="wrong issuer"),
        pytest.param(_expired(), id="expired"),
        pytest.param({"sub": None}, id="missing sub"),
        pytest.param({"exp": None}, id="missing exp"),
        pytest.param({"scope": None}, id="missing scope"),
        pytest.param({"scope": "accounts:read"}, id="scope without chat"),
        pytest.param({"scope": "chatty"}, id="scope only resembling chat"),
    ],
)
async def test_rejects_invalid_claims(
    verifier: JwksTokenVerifier, signing_key: SigningKey, overrides: dict[str, Any]
) -> None:
    with pytest.raises(InvalidTokenError):
        await verifier.verify(signing_key.token(**overrides))


async def test_rejects_a_token_signed_by_another_key_with_the_same_kid(verifier: JwksTokenVerifier) -> None:
    with pytest.raises(InvalidTokenError):
        await verifier.verify(SigningKey().token())


async def test_rejects_an_unsigned_token(verifier: JwksTokenVerifier) -> None:
    token = jwt.encode({"iss": ISSUER, "aud": BOT_AUDIENCE, "sub": "ana"}, key=None, algorithm="none")
    with pytest.raises(InvalidTokenError):
        await verifier.verify(token)


async def test_rejects_garbage(verifier: JwksTokenVerifier) -> None:
    with pytest.raises(InvalidTokenError):
        await verifier.verify("not-a-jwt")


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class FakeJwks:
    """A JWKS endpoint whose answer the test changes, counting fetches."""

    def __init__(self, *keys: SigningKey) -> None:
        self.answer: object = {"keys": [key.jwk() for key in keys]}
        self.calls = 0

    async def __call__(self) -> object:
        self.calls += 1
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def _verifier(jwks: FakeJwks, clock: FakeClock) -> JwksTokenVerifier:
    return JwksTokenVerifier(jwks, issuer=ISSUER, audience=BOT_AUDIENCE, min_refresh_seconds=10, clock=clock)


async def test_picks_up_a_key_rotated_right_after_the_last_fetch(signing_key: SigningKey) -> None:
    jwks, clock = FakeJwks(signing_key), FakeClock()
    verifier = _verifier(jwks, clock)
    await verifier.verify(signing_key.token())

    rotated = SigningKey(kid="rotated")
    jwks.answer = {"keys": [rotated.jwk()]}
    clock.now += 1
    assert (await verifier.verify(rotated.token())).user_id == "ana"
    assert jwks.calls == 2


async def test_fetches_at_most_once_per_unknown_kid_per_interval(signing_key: SigningKey) -> None:
    jwks, clock = FakeJwks(signing_key), FakeClock()
    verifier = _verifier(jwks, clock)
    unknown = SigningKey(kid="unknown")
    for _ in range(3):
        with pytest.raises(InvalidTokenError):
            await verifier.verify(unknown.token())
    assert jwks.calls == 1

    clock.now += 10
    with pytest.raises(InvalidTokenError):
        await verifier.verify(unknown.token())
    assert jwks.calls == 2


async def test_rate_limits_failed_fetches_across_kids(signing_key: SigningKey) -> None:
    jwks, clock = FakeJwks(signing_key), FakeClock()
    jwks.answer = JwksUnavailableError("idp down")
    verifier = _verifier(jwks, clock)
    for kid in ("a", "b", "c"):
        with pytest.raises(JwksUnavailableError):
            await verifier.verify(SigningKey(kid=kid).token())
    assert jwks.calls == 1

    jwks.answer = {"keys": [signing_key.jwk()]}
    clock.now += 10
    assert (await verifier.verify(signing_key.token())).user_id == "ana"
    assert jwks.calls == 2


async def test_fetches_at_most_once_per_second_across_fresh_kids(signing_key: SigningKey) -> None:
    jwks, clock = FakeJwks(signing_key), FakeClock()
    verifier = _verifier(jwks, clock)
    for kid in ("a", "b", "c"):
        with pytest.raises(InvalidTokenError):
            await verifier.verify(SigningKey(kid=kid).token())
        clock.now += 0.3
    assert jwks.calls == 1

    clock.now += 0.2
    with pytest.raises(InvalidTokenError):
        await verifier.verify(SigningKey(kid="d").token())
    assert jwks.calls == 2


async def test_skips_unparsable_keys_and_keeps_the_usable_ones(signing_key: SigningKey) -> None:
    jwks = FakeJwks(signing_key)
    broken = {"kid": "broken", "kty": "EC", "crv": "P-256", "x": "!", "y": "!"}
    jwks.answer = {"keys": [broken, signing_key.jwk()]}
    assert (await _verifier(jwks, FakeClock()).verify(signing_key.token())).user_id == "ana"


@pytest.mark.parametrize(
    "answer",
    [
        pytest.param("<html>oops</html>", id="not an object"),
        pytest.param({"no_keys": []}, id="no keys member"),
        pytest.param({"keys": "nope"}, id="keys not a list"),
        pytest.param({"keys": [{"kid": "x"}]}, id="key without kty"),
        pytest.param({"keys": [{"kid": "x", "kty": "EC", "crv": "P-256", "x": "!", "y": "!"}]}, id="bad key material"),
    ],
)
async def test_a_malformed_jwks_is_unavailable_not_an_invalid_token(signing_key: SigningKey, answer: object) -> None:
    jwks = FakeJwks()
    jwks.answer = answer
    with pytest.raises(JwksUnavailableError):
        await _verifier(jwks, FakeClock()).verify(signing_key.token())


@pytest.mark.parametrize(
    "response",
    [
        pytest.param(httpx.Response(200, text="<html>not json</html>"), id="not json"),
        pytest.param(httpx.Response(500, json={"error": "boom"}), id="server error"),
    ],
)
async def test_http_fetcher_maps_bad_responses_to_unavailable(response: httpx.Response) -> None:
    transport = httpx.MockTransport(lambda _: response)
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(JwksUnavailableError):
            await http_jwks_fetcher(client, "http://idp.test/.well-known/jwks.json")()
