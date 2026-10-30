## Summary

Describe the executable user-facing slice and its boundaries.

## Verification

- [ ] RED/GREEN behavior evidence for meaningful rules or defect fixes
- [ ] Formatting, Clippy, backend unit and real PostgreSQL integration tests
- [ ] Generated API contract, frontend type/lint/behavior and production build
- [ ] Applicable HTTP/browser/container/package gates
- [ ] Independent source review for coordination, ownership, routing or authentication changes
- [ ] docs/STATUS.md distinguishes implemented, tested, blocked and unexecuted acceptance

## Safety

- [ ] No permanent credentials, fabricated provider results or unsupported health claims
- [ ] Fake simulation is not described as live AWS connectivity
- [ ] No unauthorized cloud mutations or release/tag/image publication
- [ ] License metadata and third-party notices remain consistent
