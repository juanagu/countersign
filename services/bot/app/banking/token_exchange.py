import hashlib
import time
from collections.abc import Callable

import httpx
from pydantic import BaseModel, ValidationError

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"  # noqa: S105 (a token type URN)
# Refresh a cached token this long before it expires, so a call never starts with a dying token.
_EXPIRY_MARGIN_SECONDS = 30


class TokenExchangeError(Exception):
    """The IdP refused or failed the exchange; the tool call cannot proceed."""


class _TokenResponse(BaseModel):
    access_token: str
    expires_in: int
    token_type: str


class TokenExchanger:
    """Exchanges the user's `aud=bot` token for an audience-bound token per MCP server (security rule 1)."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        token_url: str,
        client_id: str,
        client_secret: str,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._client = client
        self._token_url = token_url
        self._auth = httpx.BasicAuth(client_id, client_secret)
        self._clock = clock
        self._cache: dict[tuple[str, str], tuple[str, float]] = {}

    async def token_for(self, subject_token: str, audience: str) -> str:
        key = (hashlib.sha256(subject_token.encode()).hexdigest(), audience)
        cached = self._cache.get(key)
        if cached and cached[1] > self._clock():
            return cached[0]
        token, expires_in = await self._exchange(subject_token, audience)
        self._prune()
        self._cache[key] = (token, self._clock() + expires_in - _EXPIRY_MARGIN_SECONDS)
        return token

    async def _exchange(self, subject_token: str, audience: str) -> tuple[str, int]:
        form = {
            "grant_type": GRANT_TYPE,
            "subject_token": subject_token,
            "subject_token_type": ACCESS_TOKEN_TYPE,
            "audience": audience,
        }
        try:
            response = await self._client.post(self._token_url, data=form, auth=self._auth, timeout=5.0)
        except httpx.HTTPError as error:
            raise TokenExchangeError(f"token endpoint unreachable: {type(error).__name__}") from error
        if response.status_code != httpx.codes.OK:
            raise TokenExchangeError(f"token exchange refused ({response.status_code})")
        try:
            body = _TokenResponse.model_validate_json(response.content)
        except ValidationError as error:
            raise TokenExchangeError("malformed token response") from error
        return body.access_token, body.expires_in

    def _prune(self) -> None:
        now = self._clock()
        for key in [k for k, (_, expiry) in self._cache.items() if expiry <= now]:
            del self._cache[key]
