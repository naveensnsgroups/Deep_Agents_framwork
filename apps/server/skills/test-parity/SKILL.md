---
name: test-parity
description: Keep a migrated test suite asserting exactly what it asserted before — equivalent assertion strength, working async awaits, correct mock and patch targets, preserved fixture lifecycle and isolation, and skipped tests that stay skipped. Use when migrating tests between any two frameworks or languages, alongside the framework-specific playbook.
allowed-tools: read_file ls glob grep
compatibility: Any test framework, any language.
---

# Test parity

A migrated test suite is dangerous in a way migrated application code is not: **a test that
passes without checking anything looks exactly like a test that passes.** Green tells you
nothing until you know they still assert what they used to.

## The one rule

**Preserve what each test asserts, not how it is written.** The suite's value is the set of
claims it makes about the system. A translation that keeps the structure but weakens the
claims has migrated the shape and thrown away the substance.

## Rules

**Match assertion strength exactly.** Identity, deep equality, and loose equality are three
different claims. Translating a strict identity check into a loose comparison — or a deep
equality check into "not null" — silently widens what the test accepts. When the target
framework has no exact equivalent, pick the *stricter* option and note it.

**An async test that is not awaited passes unconditionally.** This is the single most common
way a migrated suite becomes worthless: the assertion runs after the test has already
finished, and its failure is never attributed to anything. Every asynchronous call in a
migrated test must be awaited by the target's own mechanism, and every async test must be
registered with the target's async runner.

**Patch targets move.** Mocks are patched where a symbol is *used*, not where it is defined,
and migration usually changes the module layout — so every patch target has to be re-derived
rather than translated. A patch that silently misses leaves the real dependency in place: the
test now hits a real database or a real network, and usually still passes locally.

**Lifecycle scope is part of the test.** Setup that ran once per file versus once per test is
a different test. Migrating a per-test hook into a per-module fixture makes tests share state,
and shared state makes them order-dependent — which shows up later as a flake nobody can
reproduce.

**Isolation must survive.** If each test had a clean database, a fresh temp directory, or a
reset singleton, it still does. Losing isolation converts real failures into intermittent
ones.

**A skipped test stays skipped, with its reason.** Silently enabling a test that was skipped
for a reason produces a failure nobody can interpret. Silently dropping it loses the record
that the case exists at all. Carry over both the skip and the reason.

**Do not "fix" a failing test during migration.** If it failed before, it fails after, and you
report it as pre-existing. Adjusting an assertion so the migrated code passes is how a
migration defect gets hidden inside a test change.

## Traps

| Trap | What goes wrong |
| --- | --- |
| Un-awaited async assertion | Test passes without ever running the check |
| Rejected-promise / raises assertions | Frameworks differ on whether the callable or its result is passed; a wrong form never triggers |
| Snapshot tests | A regenerated snapshot asserts the *new* behaviour, hiding exactly what migration should catch |
| Floating-point equality | Tolerance-based comparison in one framework, exact in another |
| Auto-reset of mocks between tests | On by default in some frameworks, off in others — state bleeds |
| Fake timers / frozen clock | No equivalent in the target, so timing-dependent tests become flaky |
| Test discovery by filename | A renamed file silently stops running entirely |
| Parameterised tests | A translation that collapses cases into one loop loses per-case reporting and stops on first failure |
| Equality on objects vs references | Passes for the wrong reason when both sides are the same instance |

## Method

1. Read the test **and** the code it exercises. You cannot judge an assertion without knowing
   what it is asserting about.
2. For each test, write down the claim it makes in one sentence before translating it.
3. Translate, then check the migrated test still makes that same claim.
4. **Verify the suite can fail.** Break the implementation deliberately — change a return
   value, remove a guard — and confirm the migrated tests go red. A suite that stays green
   against broken code has migrated nothing. Restore the change afterwards.

Step 4 is the only step that actually proves the migration worked. Do not skip it because the
suite is green; green is the symptom being investigated.

## Done-check

- Every test in the source has a counterpart, or its absence is reported.
- Assertion strength is equal or stricter, never looser.
- Every async test awaits its assertions and is registered with the async runner.
- Every patch target resolves to where the symbol is now used.
- Setup and teardown run at the same scope as before.
- Skipped tests are still skipped, with their reasons.
- Pre-existing failures are reported as pre-existing, not repaired.
- The suite has been observed failing against deliberately broken code.
