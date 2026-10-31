from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterator

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from app.auth import JWTVerifier, bearer_token
from app.config import Settings
from app.errors import (
    AuthUnavailable,
    InsufficientScope,
    TokenExpired,
    TokenInvalid,
    Unauthorized,
)

KID = "test-kid"
ISSUER = "jawbts-api"
SCOPE = "play_sequence_override"


@pytest.fixture(scope="module")
def keypair() -> tuple[object, object]:
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_jwk = json.loads(RSAAlgorithm.to_jwk(private.public_key()))
    public_jwk.update({"kid": KID, "alg": "RS256", "use": "sig"})
    return private, {"keys": [public_jwk]}


class _JWKSHandler(BaseHTTPRequestHandler):
    jwks: dict = {}

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/.well-known/jwks.json":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(self.jwks).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


@pytest.fixture()
def jwks_server(keypair: tuple[object, object]) -> Iterator[str]:
    private, jwks = keypair
    _JWKSHandler.jwks = jwks
    server = ThreadingHTTPServer(("127.0.0.1", 0), _JWKSHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/.well-known/jwks.json"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def make_verifier(url: str, *, scope: str = SCOPE) -> JWTVerifier:
    settings = Settings(
        jwks_url=url,
        jwt_issuer=ISSUER,
        required_scope=scope,
        allow_insecure_jwks=True,
        jwks_cache_seconds=300,
        jwks_timeout_seconds=5,
    )
    return JWTVerifier(settings)


def sign(private: object, **overrides: object) -> str:
    now = int(time.time())
    payload = {
        "iss": ISSUER,
        "sub": "winsrewu",
        "scope": [SCOPE],
        "jti": "jti-1",
        "sid": "sid-1",
        "iat": now,
        "exp": now + 600,
    }
    payload.update(overrides)
    return jwt.encode(payload, private, algorithm="RS256", headers={"kid": KID})


def test_valid_token(jwks_server: str, keypair: tuple[object, object]) -> None:
    private, _ = keypair
    context = make_verifier(jwks_server).verify(sign(private))
    assert context.subject == "winsrewu"
    assert context.scope == (SCOPE,)
    assert context.session_id == "sid-1"


def test_missing_scope(jwks_server: str, keypair: tuple[object, object]) -> None:
    private, _ = keypair
    with pytest.raises(InsufficientScope) as excinfo:
        make_verifier(jwks_server).verify(sign(private, scope=["api"]))
    assert excinfo.value.required == SCOPE
    assert excinfo.value.status == 403


def test_scope_must_be_array(jwks_server: str, keypair: tuple[object, object]) -> None:
    private, _ = keypair
    with pytest.raises(TokenInvalid):
        make_verifier(jwks_server).verify(sign(private, scope=SCOPE))


def test_expired_token(jwks_server: str, keypair: tuple[object, object]) -> None:
    private, _ = keypair
    now = int(time.time())
    with pytest.raises(TokenExpired):
        make_verifier(jwks_server).verify(sign(private, iat=now - 1000, exp=now - 500))


def test_wrong_issuer(jwks_server: str, keypair: tuple[object, object]) -> None:
    private, _ = keypair
    with pytest.raises(TokenInvalid):
        make_verifier(jwks_server).verify(sign(private, iss="someone-else"))


def test_unknown_kid(jwks_server: str, keypair: tuple[object, object]) -> None:
    private, _ = keypair
    now = int(time.time())
    token = jwt.encode(
        {"iss": ISSUER, "sub": "x", "scope": [SCOPE], "iat": now, "exp": now + 60},
        private,
        algorithm="RS256",
        headers={"kid": "other"},
    )
    with pytest.raises(TokenInvalid):
        make_verifier(jwks_server).verify(token)


def test_wrong_signature(jwks_server: str, keypair: tuple[object, object]) -> None:
    _, jwks = keypair
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(TokenInvalid):
        make_verifier(jwks_server).verify(sign(other))


def test_alg_none_is_rejected(jwks_server: str, keypair: tuple[object, object]) -> None:
    private, _ = keypair
    now = int(time.time())
    token = jwt.encode(
        {"iss": ISSUER, "sub": "x", "scope": [SCOPE], "iat": now, "exp": now + 60},
        key=None,
        algorithm="none",
        headers={"kid": KID},
    )
    with pytest.raises(TokenInvalid):
        make_verifier(jwks_server).verify(token)


def test_jwks_unavailable(keypair: tuple[object, object]) -> None:
    private, _ = keypair
    verifier = make_verifier("http://127.0.0.1:9/.well-known/jwks.json")
    with pytest.raises(AuthUnavailable):
        verifier.verify(sign(private))


def test_malformed_token_is_invalid_not_unavailable() -> None:
    verifier = make_verifier("http://127.0.0.1:9/.well-known/jwks.json")
    with pytest.raises(TokenInvalid):
        verifier.verify("a.b.c")


def test_bearer_token_parsing() -> None:
    assert bearer_token("Bearer abc") == "abc"
    assert bearer_token("bearer abc") == "abc"
    for value in [None, "", "abc", "Basic abc", "Bearer", "Bearer a b"]:
        with pytest.raises(Unauthorized):
            bearer_token(value)
