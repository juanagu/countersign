import base64
import json

import httpx
import pytest

from app.banking.token_exchange import GRANT_TYPE, TokenExchangeError, TokenExchanger

PAYMENTS_SCOPES = frozenset({"transfers:prepare", "accounts:read", "beneficiaries:read"})


def _exchanger(handler: httpx.MockTransport) -> TokenExchanger:
    return TokenExchanger(
        httpx.AsyncClient(transport=handler),
        token_url="http://idp.test/token",
        client_id="bot",
        client_secret="s3cret",
    )


def _form(request: httpx.Request) -> dict[str, str]:
    return dict(httpx.QueryParams(request.content.decode()))


def _echo(request: httpx.Request) -> httpx.Response:
    """The IdP issuing exactly the requested scope."""
    form = _form(request)
    body = {"access_token": f"tok-{form['audience']}", "token_type": "Bearer", "scope": form["scope"]}
    return httpx.Response(200, content=json.dumps(body))


async def test_exchanges_for_the_requested_scopes_with_client_auth() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _echo(request)

    exchanger = _exchanger(httpx.MockTransport(handle))
    assert await exchanger.token_for("incoming", "mcp-gateway", PAYMENTS_SCOPES) == "tok-mcp-gateway"
    assert len(requests) == 1

    form = _form(requests[0])
    assert form["grant_type"] == GRANT_TYPE
    assert form["subject_token"] == "incoming"
    assert form["audience"] == "mcp-gateway"
    assert form["scope"] == "accounts:read beneficiaries:read transfers:prepare"  # Sorted, space-joined.
    assert requests[0].headers["authorization"].startswith("Basic ")


async def test_an_empty_scope_set_never_reaches_the_idp() -> None:
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _echo(request)

    with pytest.raises(ValueError, match="scope"):
        await _exchanger(httpx.MockTransport(handle)).token_for("incoming", "mcp-gateway", frozenset())
    assert requests == []


@pytest.mark.parametrize(
    "issued",
    [
        "accounts:read beneficiaries:read transfers:prepare transfers:execute",  # Wider: the ceiling.
        "accounts:read",  # Narrower.
        "",
    ],
)
async def test_refuses_a_token_whose_scope_is_not_the_requested_set(issued: str) -> None:
    def handle(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "tok", "token_type": "Bearer", "scope": issued})

    with pytest.raises(TokenExchangeError, match="scope"):
        await _exchanger(httpx.MockTransport(handle)).token_for("incoming", "mcp-gateway", PAYMENTS_SCOPES)


async def test_form_encodes_the_client_credentials() -> None:
    headers: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        headers.append(request.headers["authorization"])
        return _echo(request)

    exchanger = TokenExchanger(
        httpx.AsyncClient(transport=httpx.MockTransport(handle)),
        token_url="http://idp.test/token",
        client_id="bot",
        client_secret="a:b+c d%e",
    )
    await exchanger.token_for("incoming", "mcp-gateway", frozenset({"accounts:read"}))

    assert base64.b64decode(headers[0].removeprefix("Basic ")).decode() == "bot:a%3Ab%2Bc+d%25e"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(400, json={"error": "invalid_scope"}),
        httpx.Response(200, content=b"<html>oops</html>"),
        httpx.Response(200, json={"access_token": "tok", "token_type": "Bearer"}),  # No scope: unknown width.
    ],
)
async def test_raises_when_the_idp_refuses_or_answers_garbage(response: httpx.Response) -> None:
    exchanger = _exchanger(httpx.MockTransport(lambda _: response))
    with pytest.raises(TokenExchangeError):
        await exchanger.token_for("incoming", "mcp-gateway", frozenset({"accounts:read"}))


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(400, json={"error": "invalid_scope", "error_description": "secret"}), "invalid_scope"),
        (httpx.Response(400, json={"error": "made_up"}), None),
        (httpx.Response(503, content=b"<html>down</html>"), None),
    ],
)
async def test_a_refusal_carries_only_a_known_rfc_6749_code(response: httpx.Response, code: str | None) -> None:
    exchanger = _exchanger(httpx.MockTransport(lambda _: response))
    with pytest.raises(TokenExchangeError) as raised:
        await exchanger.token_for("incoming", "mcp-gateway", frozenset({"accounts:read"}))
    assert raised.value.code == code
    assert "secret" not in str(raised.value)
