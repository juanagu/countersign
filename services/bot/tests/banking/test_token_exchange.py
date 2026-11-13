import json

import httpx
import pytest

from app.banking.token_exchange import GRANT_TYPE, TokenExchangeError, TokenExchanger


def _exchanger(handler: httpx.MockTransport) -> TokenExchanger:
    return TokenExchanger(
        httpx.AsyncClient(transport=handler),
        token_url="http://idp.test/token",
        client_id="bot",
        client_secret="s3cret",
    )


async def test_exchanges_per_audience_with_client_auth() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        form = dict(httpx.QueryParams(request.content.decode()))
        body = {"access_token": f"tok-{form['audience']}", "expires_in": 300, "token_type": "Bearer"}
        return httpx.Response(200, content=json.dumps(body))

    exchanger = _exchanger(httpx.MockTransport(handle))
    assert await exchanger.token_for("incoming", "mcp-accounts") == "tok-mcp-accounts"
    assert await exchanger.token_for("incoming", "mcp-payments") == "tok-mcp-payments"
    assert len(requests) == 2

    form = dict(httpx.QueryParams(requests[0].content.decode()))
    assert form["grant_type"] == GRANT_TYPE
    assert form["subject_token"] == "incoming"
    assert form["audience"] == "mcp-accounts"
    assert requests[0].headers["authorization"].startswith("Basic ")


@pytest.mark.parametrize(
    "response",
    [httpx.Response(400, json={"error": "invalid_grant"}), httpx.Response(200, content=b"<html>oops</html>")],
)
async def test_raises_when_the_idp_refuses_or_answers_garbage(response: httpx.Response) -> None:
    exchanger = _exchanger(httpx.MockTransport(lambda _: response))
    with pytest.raises(TokenExchangeError):
        await exchanger.token_for("incoming", "mcp-accounts")
