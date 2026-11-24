# Changelog

## 0.2.0 - 2026-11-24
- Requires Node.js 22 or newer (`engines >=22`). Node 20 reached end of life on 2026-04-30.
- Tests: `npm test` now runs only the hermetic unit suite (`test/unit`): an in-memory mock registry, a fake clock and a network guard, so no sockets and no real waiting. Real-socket tests moved to `npm run test:net`, the real-internet test to `npm run test:e2e` (the `OLLAMA_FETCH_E2E` switch is gone).
- CI: one job on `ubuntu-latest` with Node 22, actions pinned to full commit SHAs, only `npm ci` and `npm test`.
- No change to `pull`, `merge` or `demo` behavior or output.

## 0.1.4 - 2026-11-24
- Fix: network error messages show the real reason (for example a proxy refusing the tunnel) instead of a bare `0`.

## 0.1.3 - 2026-11-24
- CI: simplified workflow (one Linux runner, Node 20/22/24, named steps, environment diagnostics, no dependency cache).

## 0.1.2 - 2026-11-24
- Fix: deterministic tests (mock registry closes sockets cleanly, resume test no longer races), per-test timeout in `scripts/run-tests.mjs`, job timeout in CI.
- Docs: note on how the dry-run example registry is provided.

## 0.1.1 - 2026-11-24
- Fix: `npm test` runs on Node 22+ (test files are listed by `scripts/run-tests.mjs` instead of a directory argument).
- Fix: `--help` and interrupted runs use the documented exit codes (`130` on interrupt); oversized registry responses are rejected cleanly.
- Docs: README comparison and limitations sections, corrected `--dry-run` wording, refreshed screenshots.

## 0.1.0 - 2026-11-24
- `pull`: rate-limited (shared token bucket), resumable (HTTP Range), SHA-256 verified model download into the Ollama models folder, with atomic blob and manifest writes and `--dry-run`.
- `merge`: merge split GGUF shards (v2/v3) and optionally `--register` the result as an Ollama model.
- `demo`: offline practice run on a mock registry with synthetic tiny GGUF files.
- English and Korean screen text (`--lang en|ko`, `OLLAMA_FETCH_LANG`).
