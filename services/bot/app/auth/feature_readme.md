# auth

Verifies the bearer token the BFF forwards (`aud=bot`, ES256, signed by the mock IdP's JWKS).

## Exposed interface

- `CurrentPrincipal` (FastAPI dependency): `Principal(user_id, token)`; 401 on any invalid token,
  503 when the JWKS can't be fetched or isn't a valid key set (`JwksUnavailableError`).
- `TokenVerifier` protocol and `JwksTokenVerifier`: refetches the JWKS on an unknown `kid`, at most
  once per `kid` every 10 s; after a failed fetch, no refetch for any `kid` for 10 s.
- `http_jwks_fetcher`: GETs the JWKS; the verifier validates it with a Pydantic model.

## Data flow

`Authorization: Bearer` → `JwksTokenVerifier.verify` (signature, `iss`, `aud`, `exp`, `sub`) →
`Principal`. The raw token is kept only for the Phase 2 token exchange and is never forwarded.
