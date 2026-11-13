import time
from typing import Any

import jwt
import pytest

from app.auth.token_verifier import BOT_AUDIENCE, InvalidTokenError, JwksTokenVerifier
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


async def test_refetches_jwks_for_an_unknown_kid_but_rate_limits_it(signing_key: SigningKey) -> None:
    rotated = SigningKey(kid="rotated")
    calls = 0

    async def fetch() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"keys": [signing_key.jwk()] if calls == 1 else [rotated.jwk()]}

    verifier = JwksTokenVerifier(fetch, issuer=ISSUER, audience=BOT_AUDIENCE, min_refresh_seconds=0)
    await verifier.verify(signing_key.token())
    assert (await verifier.verify(rotated.token())).user_id == "ana"
    assert calls == 2

    limited = JwksTokenVerifier(fetch, issuer=ISSUER, audience=BOT_AUDIENCE, min_refresh_seconds=60)
    for _ in range(3):
        with pytest.raises(InvalidTokenError):
            await limited.verify(SigningKey(kid="unknown").token())
    assert calls == 3
