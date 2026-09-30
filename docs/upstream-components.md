# Upstream component review

This review is pinned to source revisions so future updates can be assessed as new changes.

| Source | Reviewed revision | Relevant capability | Decision |
| --- | --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | `8f195c93d7e7acfef95acf273f0e49cce917e291` | `codex-rs/apply-patch` parses bounded file operations and finds context with exact, trailing-whitespace, trimmed, then Unicode-normalized matching. | Adopted the update-hunk format and first three matching passes in `workspace.patch`, with one-file scope, required SHA-256, unique-match rejection, workspace path enforcement, size limits, atomic replacement, and an existing task-owned restore checkpoint. The Unicode-normalization fallback is intentionally excluded. |
| [Grok Build](https://github.com/xai-org/grok-build) | `f0e3be1100ef5252488e3be8bb0e91cf68d8c305` | Its in-tree matcher identifies itself as a Codex verbatim port and also includes the upstream Unicode-normalization fallback; its workspace crate adds worktree strategy and telemetry layers. | Not copied. The Codex source is the direct origin and KianCode deliberately rejects ambiguous matches. Grok telemetry, authentication, model, and remote worktree layers do not fit this runtime boundary. |
| [Claude Code](https://github.com/anthropics/claude-code) | repository reviewed 2026-09-27 | Public distribution and workflow documentation. | No source copied: its license reserves all rights and points use to Anthropic commercial terms. |
| [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) | repository reviewed 2026-09-27 | Apache-2.0 process-level filesystem and network sandbox. | License-compatible but not imported. KianCode's current gap was context-safe file mutation inside its existing scoped workspace tool; adopting a process sandbox is a separate runtime and deployment decision. |

## Shipped behavior

`workspace.patch` accepts one `*** Update File` operation. It requires the hash returned by `workspace.read`, preserves LF or CRLF, rejects invalid UTF-8, paths and symlinks outside the workspace, stale content, ambiguous context, multiple files, insertion-only hunks, oversized patches, and oversized targets. A successful patch returns the same checkpoint contract as `workspace.write`, so `workspace.restore` can revert it while the written hash remains unchanged.

The implementation is a modified TypeScript derivative. Attribution and the upstream Apache-2.0 terms are in `NOTICE` and `third_party/openai-codex/`.
