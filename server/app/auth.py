# Bearer RS256 only. Issuer, expiry and play_sequence_override scope are required; JWKS failures are 503, not 401.
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from threading import Lock
from typing import Any

import jwt
from jwt import PyJWKClient
from jwt.exceptions import (
    ExpiredSignatureError,
    InvalidIssuerError,
    InvalidTokenError,
    PyJWKClientConnectionError,
    PyJWKClientError,
)

from .config import Settings
from .errors import (
    AuthUnavailable,
    InsufficientScope,
    TokenExpired,
    TokenInvalid,
    Unauthorized,
)

LOGGER = logging.getLogger(__name__)

JWT_ALG = "RS256"


@dataclass(frozen=True)
class AuthContext:
    subject: str
    scope: tuple[str, ...]
    claims: dict[str, Any]
    token_id: str | None = None
    session_id: str | None = None


class JWTVerifier:
    def __init__(self, settings: Settings) -> None:
        self._issuer = settings.jwt_issuer
        self._scope = settings.required_scope
        self._leeway = settings.jwt_leeway_seconds
        self._lock = Lock()
        self._client = PyJWKClient(
            settings.jwks_url,
            cache_jwk_set=True,
            lifespan=max(0, settings.jwks_cache_seconds),
            headers={"User-Agent": f"{settings.service_name}/{settings.version}"},
            timeout=settings.jwks_timeout_seconds,
        )
        self._last_success: float | None = None
        self._last_failure: str | None = None

    @property
    def last_success(self) -> float | None:
        return self._last_success

    @property
    def last_failure(self) -> str | None:
        return self._last_failure

    def verify(self, token: str) -> AuthContext:
        if not token or len(token) > 16_384:
            raise TokenInvalid("token is empty or too large")

        try:
            signing_key = self._client.get_signing_key_from_jwt(token)
        except InvalidTokenError as exc:
            raise TokenInvalid("token is not a valid JWT") from exc
        except PyJWKClientConnectionError as exc:
            self._last_failure = str(exc)
            LOGGER.warning("JWKS unavailable: %s", exc)
            raise AuthUnavailable() from exc
        except PyJWKClientError as exc:
            self._last_failure = str(exc)
            LOGGER.info("JWKS key lookup failed: %s", exc)
            raise TokenInvalid("no key in the JWKS matches the token kid") from exc
        except Exception as exc:  # pragma: no cover - defence in depth
            self._last_failure = str(exc)
            LOGGER.exception("unexpected JWKS failure")
            raise AuthUnavailable() from exc

        try:
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=[JWT_ALG],
                issuer=self._issuer,
                leeway=self._leeway,
                options={
                    "require": ["exp", "iat", "sub"],
                    "verify_aud": False,
                    "verify_iss": True,
                },
            )
        except ExpiredSignatureError as exc:
            raise TokenExpired() from exc
        except InvalidIssuerError as exc:
            raise TokenInvalid("token issuer does not match") from exc
        except InvalidTokenError as exc:
            raise TokenInvalid("token verification failed") from exc
        except Exception as exc:  # pragma: no cover - defence in depth
            LOGGER.exception("unexpected JWT verification failure")
            raise TokenInvalid("token verification failed") from exc

        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject:
            raise TokenInvalid("token has no subject")

        raw_scope = claims.get("scope")
        if not isinstance(raw_scope, list) or not all(
            isinstance(item, str) for item in raw_scope
        ):
            raise TokenInvalid("token scope must be an array of strings")
        scope = tuple(raw_scope)
        if self._scope not in scope:
            raise InsufficientScope(self._scope, list(scope))

        self._last_success = time.time()
        self._last_failure = None
        return AuthContext(
            subject=subject,
            scope=scope,
            claims=claims,
            token_id=claims.get("jti") if isinstance(claims.get("jti"), str) else None,
            session_id=claims.get("sid") if isinstance(claims.get("sid"), str) else None,
        )


def bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise Unauthorized()
    parts = authorization.strip().split()
    if len(parts) != 2:
        raise Unauthorized("Authorization header must be exactly 'Bearer <token>'")
    scheme, token = parts
    if scheme.lower() != "bearer" or not token:
        raise Unauthorized("Authorization header must be exactly 'Bearer <token>'")
    return token
