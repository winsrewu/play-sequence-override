from __future__ import annotations


class ApiError(Exception):

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def to_dict(self) -> dict[str, dict[str, str]]:
        return {"error": {"code": self.code, "message": self.message}}


class Unauthorized(ApiError):
    def __init__(self, message: str = "Authorization: Bearer <token> is required") -> None:
        super().__init__(401, "unauthorized", message)


class TokenExpired(ApiError):
    def __init__(self, message: str = "token has expired") -> None:
        super().__init__(401, "token_expired", message)


class TokenInvalid(ApiError):
    def __init__(self, message: str = "token is invalid") -> None:
        super().__init__(401, "token_invalid", message)


class InsufficientScope(ApiError):
    def __init__(self, required: str, scope: list[str] | None) -> None:
        super().__init__(
            403,
            "insufficient_scope",
            f'token scope must include "{required}"',
        )
        self.required = required
        self.scope = scope

    def to_dict(self) -> dict[str, object]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "required": self.required,
                "scope": self.scope,
            }
        }


class AuthUnavailable(ApiError):
    def __init__(self, message: str = "JWKS is unavailable") -> None:
        super().__init__(503, "auth_unavailable", message)


class InvalidRequest(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(400, "invalid_request", message)


class UnsupportedProvider(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(400, "unsupported_provider", message)


class UnknownInternalId(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(404, "unknown_internal_id", message)


class VideoUnavailable(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(404, "video_unavailable", message)


class UpstreamError(ApiError):
    def __init__(self, message: str = "Bilibili request failed") -> None:
        super().__init__(502, "upstream_error", message)


class UpstreamTimeout(ApiError):
    def __init__(self, message: str = "Bilibili request timed out") -> None:
        super().__init__(504, "upstream_timeout", message)


class AudioTooLarge(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(413, "audio_too_large", message)


class AudioDecodeError(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(502, "audio_decode_failed", message)


class InvalidAudioFormat(ApiError):

    def __init__(self, message: str) -> None:
        super().__init__(502, "invalid_audio_format", message)


class RangeNotSupported(ApiError):

    def __init__(self, message: str) -> None:
        super().__init__(502, "range_not_supported", message)


class EmbeddingFailed(ApiError):
    def __init__(self, message: str) -> None:
        super().__init__(500, "embedding_failed", message)
