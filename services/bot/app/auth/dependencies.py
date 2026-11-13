import logging
from typing import Annotated

import httpx
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.token_verifier import InvalidTokenError, Principal, TokenVerifier

logger = logging.getLogger(__name__)
_bearer = HTTPBearer(auto_error=False)
_UNAUTHORIZED = HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid_token", headers={"WWW-Authenticate": "Bearer"})


async def require_principal(
    request: Request, credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]
) -> Principal:
    if credentials is None:
        raise _UNAUTHORIZED
    verifier: TokenVerifier = request.app.state.token_verifier
    try:
        return await verifier.verify(credentials.credentials)
    except InvalidTokenError as error:
        logger.info("rejected bearer token", extra={"reason": str(error)})
        raise _UNAUTHORIZED from error
    except httpx.HTTPError as error:
        logger.error("jwks unavailable", extra={"error": type(error).__name__})
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "idp_unavailable") from error


CurrentPrincipal = Annotated[Principal, Depends(require_principal)]
