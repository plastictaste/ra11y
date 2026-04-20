# 0020 — Attestation ledger integrity

- Status: Accepted
- Date: 2026-04-19
- Supersedes: none
- Superseded by: none
- Related: ADR 0011 (Evidence as a first-class primitive), ADR 0013 (Rule-scoped attestations), ADR 0017 (Conformance statement output)

## Context

`.ra11y/attestations.jsonl` (written by the `attest` MCP tool and the `ra11y attest` CLI, read by the conformance and checklist builders) is plain JSONL with caller-supplied `attestedAt` and `by` fields. The store has no per-record integrity:

- A caller can hand-edit the file with `vim` and delete a record without a trace.
- `attestedAt` is whatever string the writer passed; backdating a verdict to before a breaking source change is mechanical.
- Records can be reordered; the on-disk position is not load-bearing today, but "the ledger reads clean" will be load-bearing once conformance bundles are signed against it.
- The write path enforces shape but not provenance — anything that matches the `AttestationRecord` contract is accepted.

A real WCAG / VPAT / Section 508 submission needs the evaluator to be able to point at an audit trail and say "this attestation was made at this time by this person and has not been altered since." JSONL with no extra structure gives them no tool for that claim.

The question is how much of the integrity story ra11y should own itself versus delegate to an existing trust root. Two options were on the table:

**(a) Per-record SHA-256 hash chain.** Each new record carries a `prevHash` field containing SHA-256(previous record line). The chain is self-verifying: to detect backdating, reordering, or deletion you walk the file recomputing hashes. The head of the chain becomes the integrity anchor.

**(b) Git as the trust root.** ra11y ships a `ra11y attestations verify` subcommand that compares the working-tree JSONL against `git show HEAD:.ra11y/attestations.jsonl` and against git blame dates for each entry:

- Every HEAD entry that is missing from the working tree is flagged as `removed-since-head`.
- Every entry whose `attestedAt` is later than the commit that first added that line is flagged as `backdated-attestation` (the canonical attack: "I wrote this in July but dated it January before the regression").
- Every entry whose `attestedAt` is earlier than the adding commit's date is flagged as `future-attestation-before-commit` (rarer; plausible when the authoring clock was wrong, still worth surfacing).

Option (a) is heavier: it requires a migration for every ledger that already exists, a write-side library change, and a readable-but-foreign `prevHash` field on every record that agents and hand-editors now need to maintain. The chain itself only catches the same attacks git already catches once the file is committed — working-tree tampering before commit is still trivial.

Option (b) is lighter and exploits a trust root every ra11y consumer already has. Git's Merkle tree is a per-blob hash chain with object-level signatures (via commit signing) and a published history; ra11y doesn't need to reinvent any of it. The threat model that option (a) uniquely catches — an attacker with write access to the working tree but no write access to the git history — is almost empty in practice. An attacker who can edit `vim .ra11y/attestations.jsonl` can also edit `src/`, `ra11y.config.ts`, or the rules the scanner runs; per-record hashes do not raise the bar meaningfully against that adversary.

## Decision

Ship option (b): a `ra11y attestations verify` subcommand that uses git as the integrity root. **Do not** add a per-record SHA-256 hash chain.

Scope of `ra11y attestations verify`:

1. Compare working-tree `.ra11y/attestations.jsonl` against `git show HEAD:.ra11y/attestations.jsonl`.
2. Flag entries that exist in HEAD but are missing from the working tree as `removed-since-head`.
3. For each entry in the working tree that is also committed in git (located via `git blame --line-porcelain` on the ledger file), compare `attestedAt` against the author-date of the commit that first introduced that line:
   - `attestedAt` **later than** adding-commit date → `backdated-attestation`.
   - `attestedAt` **earlier than** adding-commit date → `future-attestation-before-commit`.
4. Working-tree-only entries (lines not yet committed) are reported as `uncommitted` — informational, not a failure. A caller who just ran `attest` and has not yet committed the ledger is expected to see their new record here.
5. Outside a git repo or when `HEAD:.ra11y/attestations.jsonl` does not yet exist, the command emits a clear error describing which precondition failed rather than claiming success.
6. Exit codes follow the existing CLI convention: `ExitCode.OK` (0) when the ledger is clean, `ExitCode.USER_ERROR` (2) on any flagged entry or precondition failure.

The verify logic is a pure helper (`verifyAttestationIntegrity`) that takes the two JSONL bodies plus a line-to-commit-date map as arguments. The CLI wrapper handles git shell-out and passes the materialized inputs in. Tests exercise the helper without needing a real git repo.

## Consequences

- **No schema change.** `AttestationRecord` stays as it is today; no `prevHash` / `signature` / `version` field. Migrations are unnecessary; every existing ledger verifies without modification once committed.
- **Working-tree edits are intentional.** A caller who edits the ledger between `attest` and `git commit` is not necessarily malicious — they may be amending a reason string, for example. The verify command distinguishes "committed and altered since" (failure) from "uncommitted" (informational).
- **The integrity story rides git.** `conformance_statement` already signs a bundle over the ledger's state at scan time (ADR 0017). Once the ledger is committed and the bundle is emitted, drift in either direction is detectable — the signature catches post-emission ledger edits, and `attestations verify` catches pre-emission backdating against the commit history.
- **Threat model is explicit.** Attackers with pre-commit write access are out of scope. A compromised dev machine can forge any evidence ra11y could produce, including a hash chain; the correct control for that adversary is operational (signed commits, branch protection, CODEOWNERS on `.ra11y/`), not a second self-verifying file inside the repo.
- **`ra11y attestations verify` joins the existing `ra11y attestations prune`** under the same subcommand namespace, giving the CLI one consistent place for ledger hygiene.
- The `V1-CERT-ATTEST-INTEGRITY` backlog item closes with this decision and the shipped subcommand.

## Alternatives considered

**Per-record SHA-256 hash chain (option a).** Rejected as redundant with git's Merkle tree for the threat model that matters. It adds a field on every record, requires a migration for existing ledgers, and only uniquely defends against "attacker edits the working tree but cannot touch git history" — a combination that is rare in practice and is better addressed by commit-level controls anyway.

**Signed attestations (e.g., GPG / sigstore).** Out of scope for v1.0. Signing requires a key-distribution story ra11y does not currently own. The `conformance_statement` signature (ADR 0017) already addresses the one place ra11y itself needs to make a signed claim — over the bundle, not over each ledger entry.

**Stronger clock validation (e.g., rejecting any `attestedAt` from the future).** Out of scope for this ADR. Clock skew is a known failure mode but not specific to integrity; would be its own ADR if revisited.
