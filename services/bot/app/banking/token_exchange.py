from urllib.parse import quote_plus

import httpx
from pydantic import BaseModel, ValidationError

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"  # noqa: S105 (a token type URN)


class TokenExchangeError(Exception):
    """The IdP refused or failed the exchange; the tool call cannot proceed."""


class _TokenResponse(BaseModel):
    access_token: str
    token_type: str
    scope: str


class TokenExchanger:
    """Exchanges the user's `aud=bot` token for an `aud=mcp-gateway` token (security rule 1, ADR 017, ADR 020).

    The gateway exchanges again for each backend. Nothing is cached: the BFF mints a fresh bot token per request.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        token_url: str,
        client_id: str,
        client_secret: str,
    ):
        self._client = client
        self._token_url = token_url
        # RFC 6749 §2.3.1: form-encode each credential, as the IdP decodes them (a secret may hold ':' or '%').
        self._auth = httpx.BasicAuth(quote_plus(client_id, safe=""), quote_plus(client_secret, safe=""))

    async def token_for(self, subject_token: str, audience: str, scopes: frozenset[str]) -> str:
        """A token for exactly `scopes`: one the IdP issued wider or narrower is refused, never used."""
        if not scopes:
            raise ValueError("a token exchange asks for at least one scope")
        form = {
            "grant_type": GRANT_TYPE,
            "subject_token": subject_token,
            "subject_token_type": ACCESS_TOKEN_TYPE,
            "audience": audience,
            "scope": " ".join(sorted(scopes)),
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
        if frozenset(body.scope.split()) != scopes:
            raise TokenExchangeError("issued scope differs from the requested scope")
        return body.access_token
