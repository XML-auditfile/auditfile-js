# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- TypeScript declarations in the package (`types/`), generated from the JSDoc.
- Release workflow: npm Trusted Publishing with provenance, dist-tags `latest`, `next` and `release-X.Y`.
- Typed row accessors (`getString`, `getDecimal`, `getInteger`, `getDate`, `getDateTime`, `getTime`, `getBoolean`, `has`) that check the column type, also with a column looked up once.
- Report counts per severity that include diagnostics left out of a full list; errors take the place of infos and warnings.
- Cancellation in the scan and load phases; XAF-S006 (missing required field) in unverified mode; XAF-X004 for a part of a
  split file in another encoding than the first part.
- Dialect actions, view aggregates and view operators are checked when the definitions are loaded.
- `DialectAction`, `ViewAggregate` and `ViewOperator` constants.
- Views: joins with `alternatives` (`ViewJoin.alternatives`) and the `pseudonym` operation (`ViewOperator.Pseudonym`,
  `ViewValue.prefix`); the views `ledger` and `ledger_pseudonymized`.
- Streaming reader for XAF and related audit files, ported from auditfile-dotnet with the same API in JavaScript style:
  `Auditfile.read`, `validate`, `scan` and `open`, `AuditfileSource`, `AuditfileVersion`, `AuditfileSchema` with JSON round-trip,
  sinks and `MemorySink`, views (`ViewDefinition.run`, `MemorySink.run`).
- Version resolution (forced, registry, alias, resolver), scan and load phases, split audit files, dialect corrections,
  key and reference checks, XAF business rules, diagnostics in Dutch and English.
- Streaming XSD validator for the XSD subset of auditfile-spec, including identity constraints.
- Exact decimals (`Decimal`) for amounts.
- Security: DTDs refused, embedded-only XSD resolution, depth and diagnostic limits, caller-owned streams left open.
