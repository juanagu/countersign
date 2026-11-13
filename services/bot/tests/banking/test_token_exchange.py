import json

import httpx
import pytest

from app.banking.token_exchange import GRANT_TYPE, TokenExchangeError, TokenExchanger


def _exchanger(handler: httpx.MockTransport, clock: list[float]) -> TokenExchanger:
    return TokenExchanger(
        httpx.AsyncClient(transport=handler),
        token_url="http://idp.test/token",
        client_id="bot",
        client_secret="s3cret",
        clock=lambda: clock[0],
    )


async def test_exchanges_with_client_auth_and_caches_per_audience() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        form = dict(httpx.QueryParams(request.content.decode()))
        body = {"access_token": f"tok-{form['audience']}", "expires_in": 300, "token_type": "Bearer"}
        return httpx.Response(200, content=json.dumps(body))

    clock = [0.0]
    exchanger = _exchanger(httpx.MockTransport(handle), clock)
    assert await exchanger.token_for("incoming", "mcp-accounts") == "tok-mcp-accounts"
    assert await exchanger.token_for("incoming", "mcp-accounts") == "tok-mcp-accounts"
    assert await exchanger.token_for("incoming", "mcp-payments") == "tok-mcp-payments"
    assert len(requests) == 2

    form = dict(httpx.QueryParams(requests[0].content.decode()))
    assert form["grant_type"] == GRANT_TYPE
    assert form["subject_token"] == "incoming"
    assert requests[0].headers["authorization"].startswith("Basic ")

    clock[0] = 300.0  # past expiry minus the margin: exchanged again
    await exchanger.token_for("incoming", "mcp-accounts")
    assert len(requests) == 3


@pytest.mark.parametrize(
    "response",
    [httpx.Response(400, json={"error": "invalid_grant"}), httpx.Response(200, content=b"<html>oops</html>")],
)
async def test_raises_when_the_idp_refuses_or_answers_garbage(response: httpx.Response) -> None:
    exchanger = _exchanger(httpx.MockTransport(lambda _: response), [0.0])
    with pytest.raises(TokenExchangeError):
        await exchanger.token_for("incoming", "mcp-accounts")
