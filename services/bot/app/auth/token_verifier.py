import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

import httpx
import jwt
from pydantic import BaseModel, ConfigDict, ValidationError

BOT_AUDIENCE = "bot"
_ALGORITHMS = ["ES256"]
_REQUIRED_CLAIMS = ["exp", "iat", "iss", "aud", "sub"]
_JWKS_TIMEOUT_SECONDS = 5.0

JwksFetcher = Callable[[], Awaitable[object]]
Clock = Callable[[], float]


class InvalidTokenError(Exception):
    """The bearer token is missing a claim, expired, for another audience, or not signed by the IdP."""


class JwksUnavailableError(Exception):
    """The IdP's JWKS could not be fetched, or what came back is not a key set."""


class _Jwk(BaseModel):
    model_config = ConfigDict(extra="allow")
    kty: str
    kid: str | None = None


class _Jwks(BaseModel):
    keys: list[_Jwk]


@dataclass(frozen=True)
class Principal:
    user_id: str
    # Kept only to exchange for audience-bound MCP tokens; never forwarded or shown to the model.
    token: str = field(repr=False)


class TokenVerifier(Protocol):
    async def verify(self, token: str) -> Principal: ...


def http_jwks_fetcher(client: httpx.AsyncClient, url: str) -> JwksFetcher:
    async def fetch() -> object:
        try:
            response = await client.get(url, timeout=_JWKS_TIMEOUT_SECONDS)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise JwksUnavailableError(type(error).__name__) from error

    return fetch


def _parse_jwks(raw: object) -> dict[str, jwt.PyJWK]:
    try:
        jwks = _Jwks.model_validate(raw)
        return {key.kid: jwt.PyJWK(key.model_dump()) for key in jwks.keys if key.kid is not None}
    except (ValidationError, jwt.PyJWTError) as error:
        raise JwksUnavailableError("malformed jwks") from error


class JwksTokenVerifier:
    """Verifies IdP-signed JWTs for one audience, refetching the JWKS when it sees an unknown key id.

    Each unknown kid triggers at most one fetch per interval, so a key rotated right after the last
    fetch is still picked up; after a failed fetch no kid triggers another until the interval passes.
    """

    def __init__(
        self,
        fetch_jwks: JwksFetcher,
        *,
        issuer: str,
        audience: str,
        min_refresh_seconds: float = 10.0,
        clock: Clock = time.monotonic,
    ):
        self._fetch_jwks = fetch_jwks
        self._issuer = issuer
        self._audience = audience
        self._min_refresh_seconds = min_refresh_seconds
        self._clock = clock
        self._keys: dict[str, jwt.PyJWK] = {}
        self._last_attempt_by_kid: dict[str, float] = {}
        self._last_failure = float("-inf")
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
            await self._refresh_for(kid)
        return self._keys.get(kid)

    async def _refresh_for(self, kid: str) -> None:
        async with self._lock:
            if kid in self._keys:  # another request fetched it while this one waited
                return
            now = self._clock()
            if self._within_interval(self._last_failure, now):
                raise JwksUnavailableError("backing off after a failed jwks fetch")
            if self._within_interval(self._last_attempt_by_kid.get(kid, float("-inf")), now):
                return
            self._forget_attempts_before(now - self._min_refresh_seconds)
            self._last_attempt_by_kid[kid] = now
            try:
                self._keys = _parse_jwks(await self._fetch_jwks())
            except JwksUnavailableError:
                self._last_failure = now
                raise

    def _within_interval(self, since: float, now: float) -> bool:
        return now - since < self._min_refresh_seconds

    def _forget_attempts_before(self, cutoff: float) -> None:
        # Bounds memory when tokens carry many made-up kids.
        self._last_attempt_by_kid = {kid: at for kid, at in self._last_attempt_by_kid.items() if at >= cutoff}
