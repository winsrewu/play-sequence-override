from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import jwt
import numpy as np
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from app.config import Settings
from app.main import create_app

ROOT = Path(__file__).resolve().parent.parent
KID = "live-kid"
ISSUER = "jawbts-api"
SCOPE = "play_sequence_override"


class _Handler(BaseHTTPRequestHandler):
    jwks: dict = {}

    def do_GET(self) -> None:  # noqa: N802
        body = json.dumps(self.jwks).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


@pytest.mark.skipif(os.environ.get("RUN_LIVE") != "1", reason="set RUN_LIVE=1")
def test_live_embedding_matches_precomputed_vector() -> None:
    import imageio_ffmpeg

    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = json.loads(RSAAlgorithm.to_jwk(private.public_key()))
    public.update({"kid": KID, "alg": "RS256", "use": "sig"})
    _Handler.jwks = {"keys": [public]}
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    now = int(time.time())
    token = jwt.encode(
        {
            "iss": ISSUER,
            "sub": "live-test",
            "scope": [SCOPE],
            "iat": now,
            "exp": now + 600,
        },
        private,
        algorithm="RS256",
        headers={"kid": KID},
    )

    settings = Settings(
        jwks_url=f"http://127.0.0.1:{server.server_port}/.well-known/jwks.json",
        allow_insecure_jwks=True,
        jwks_cache_seconds=60,
        catalog_path=ROOT / "data" / "music.v2.json",
        catalog_strict=False,
        model_path=ROOT / "assets" / "mn10_as_mAP_471.pt",
        efficientat_path=ROOT / "vendor" / "EfficientAT",
        ffmpeg_bin=imageio_ffmpeg.get_ffmpeg_exe(),
        max_duration_seconds=900,
    )
    app = create_app(settings=settings)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/embed",
                json={"internal_id": "BBV1114y127ih"},
                headers={"Authorization": f"Bearer {token}"},
            )
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["dim"] == 960
            assert len(body["embedding"]) == 960
            vector = np.asarray(body["embedding"], dtype=np.float32)
            assert np.isfinite(vector).all()
            assert 1.0 < float(np.linalg.norm(vector)) < 20.0

            reference = np.asarray(
                json.loads(
                    (Path("/mnt/g/C/embed_data/music_embed_0.json")).read_text()
                )["data"][0]["embed"],
                dtype=np.float32,
            )
            cosine = float(
                vector @ reference / (np.linalg.norm(vector) * np.linalg.norm(reference))
            )
            print(f"live cosine against precomputed vector: {cosine:.6f}")
            assert cosine > 0.95
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
