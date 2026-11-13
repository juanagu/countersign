import httpx
from pydantic import BaseModel, ValidationError

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"  # noqa: S105 (a token type URN)


class TokenExchangeError(Exception):
    """The IdP refused or failed the exchange; the tool call cannot proceed."""


class _TokenResponse(BaseModel):
    access_token: str
    token_type: str


class TokenExchanger:
    """Exchanges the user's `aud=bot` token for an audience-bound token per MCP server (security rule 1).

    Nothing is cached: the BFF mints a fresh bot token per request, and a run exchanges once per server.
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
        self._auth = httpx.BasicAuth(client_id, client_secret)

    async def token_for(self, subject_token: str, audience: str) -> str:
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
        return body.access_token
