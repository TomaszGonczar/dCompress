# ADR 007 — TypeScript on Node

**Status:** Accepted
**Date:** 2026-09-13
**Deciders:** Operator
**Supersedes:** nothing
**Affects:** DEVELOPMENT_PLAN P0–P1; CONCEPT §§6–7; OG-55…OG-71

## Context

dcompact needs one implementation shared by a CLI, short-lived hook commands, agent
adapters, and the core extraction engine. Hooks are launched as commands by host agents, so
installation should not require a separate daemon, runtime service, or language-specific
environment. The core also needs strict types around fact and snapshot shapes because schema
mistakes become integrity failures.

OMP extensions are already TypeScript-shaped, while Node is available on the supported agent
installations and provides the standard-library filesystem and process APIs needed outside
the pure core. The repository is an ESM project targeting Node 20 and 22.

## Decision

dcompact is implemented in strict TypeScript, emitted and run as ESM on Node 20+ (with Node
20 and 22 in CI). The distributable CLI and hook entry points use Node's standard library;
runtime dependencies are kept to the reviewed minimum and no network client is introduced.
Core modules remain pure and do not import Node I/O or read `process.env`; adapters, store,
and the CLI receive their I/O and environment at the boundary.

TypeScript is a development/build tool, not a requirement for the user's runtime. The
published command is a self-contained Node-compatible executable entry point, and OMP's
TypeScript extension can share the relevant types and adapter contracts without introducing
a second implementation of extraction rules.

## Consequences

- One language and module system covers the CLI, adapters, store, tests, and OMP integration.
- Strict checking catches malformed schema shapes before they reach hashing or persistence.
- Node 20+ is a prerequisite; older runtimes and non-Node hosts are outside the v0.1 support
  claim.
- Native platform differences still exist at the I/O boundary and require adapter and CI
  coverage. Keeping them out of `src/core/**` preserves portability of the deterministic
  engine.

## Alternatives considered

- **Shell-only implementation:** rejected because JSON, Unicode canonicalization, typed fact
  merging, and cross-platform hooks would be fragile and difficult to verify.
- **Rust or Go binary:** viable for a standalone CLI, but rejected for this phase because it
  would duplicate the TypeScript OMP extension and increase the integration/toolchain
  surface.
- **JavaScript without types:** rejected because the schema and adapter boundaries benefit
  directly from strict compile-time checks.
