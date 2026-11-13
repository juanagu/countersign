import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx
import jwt

BOT_AUDIENCE = "bot"
_ALGORITHMS = ["ES256"]
_REQUIRED_CLAIMS = ["exp", "iat", "iss", "aud", "sub"]

JwksFetcher = Callable[[], Awaitable[dict[str, Any]]]


class InvalidTokenError(Exception):
    """The bearer token is missing a claim, expired, for another audience, or not signed by the IdP."""


@dataclass(frozen=True)
class Principal:
    user_id: str
    # Kept only to exchange for audience-bound MCP tokens; never forwarded or shown to the model.
    token: str = field(repr=False)


class TokenVerifier(Protocol):
    async def verify(self, token: str) -> Principal: ...


def http_jwks_fetcher(client: httpx.AsyncClient, url: str) -> JwksFetcher:
    async def fetch() -> dict[str, Any]:
        response = await client.get(url, timeout=5.0)
        response.raise_for_status()
        body: dict[str, Any] = response.json()
        return body

    return fetch


class JwksTokenVerifier:
    """Verifies IdP-signed JWTs for one audience, refetching the JWKS when it sees an unknown key id."""

    def __init__(self, fetch_jwks: JwksFetcher, *, issuer: str, audience: str, min_refresh_seconds: float = 10.0):
        self._fetch_jwks = fetch_jwks
        self._issuer = issuer
        self._audience = audience
        self._min_refresh_seconds = min_refresh_seconds
        self._keys: dict[str, jwt.PyJWK] = {}
        self._last_refresh = float("-inf")
        self._lock = asyncio.Lock()

    async def verify(self, token: str) -> Principal:
        try:
            kid = jwt.get_unverified_header(token).get("kid")
            key = await self._key(kid) if isinstance(kid, str) else None
            if key is None:
                raise InvalidTokenError("unknown signing key")
            claims = jwt.decode(
                token,
                key=key,
                algorithms=_ALGORITHMS,
                audience=self._audience,
                issuer=self._issuer,
                options={"require": _REQUIRED_CLAIMS},
            )
        except jwt.PyJWTError as error:
            raise InvalidTokenError(str(error)) from error
        return Principal(user_id=str(claims["sub"]), token=token)

    async def _key(self, kid: str) -> jwt.PyJWK | None:
        if kid not in self._keys:
            await self._refresh()
        return self._keys.get(kid)

    async def _refresh(self) -> None:
        async with self._lock:
            if time.monotonic() - self._last_refresh < self._min_refresh_seconds:
                return
            jwks = await self._fetch_jwks()
            self._keys = {key["kid"]: jwt.PyJWK(key) for key in jwks.get("keys", []) if "kid" in key}
            self._last_refresh = time.monotonic()
