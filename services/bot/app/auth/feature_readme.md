# auth

Verifies the bearer token the BFF forwards (`aud=bot`, ES256, signed by the mock IdP's JWKS).

## Exposed interface

- `CurrentPrincipal` (FastAPI dependency): `Principal(user_id, token)`; 401 on any invalid token,
  503 when the JWKS can't be fetched.
- `TokenVerifier` protocol and `JwksTokenVerifier` (refetches the JWKS on an unknown `kid`, at most
  every 10 s).

## Data flow

`Authorization: Bearer` → `JwksTokenVerifier.verify` (signature, `iss`, `aud`, `exp`, `sub`) →
`Principal`. The raw token is kept only for the Phase 2 token exchange and is never forwarded.
