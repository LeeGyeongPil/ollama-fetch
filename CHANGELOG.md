# Changelog

## 0.1.0 - 2026-11-24
- `pull`: rate-limited (shared token bucket), resumable (HTTP Range), SHA-256 verified model download into the Ollama models folder, with atomic blob and manifest writes and `--dry-run`.
- `merge`: merge split GGUF shards (v2/v3) and optionally `--register` the result as an Ollama model.
- `demo`: offline practice run on a mock registry with synthetic tiny GGUF files.
- English and Korean screen text (`--lang en|ko`, `OLLAMA_FETCH_LANG`).
