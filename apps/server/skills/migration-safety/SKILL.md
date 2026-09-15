---
name: migration-safety
description: The rules that hold for every code migration regardless of language or framework — preserve behaviour exactly, migrate bugs faithfully, never refactor while translating, never widen permissions or weaken error handling. Use at the start of any migration, and whenever no language-specific playbook matches the file in front of you.
allowed-tools: read_file ls glob grep
compatibility: Any source and target language. No version constraints.
---

# Migration safety

Applies to every migration. Where a language-specific playbook disagrees with this, the
playbook wins on mechanics — but never on the principle that behaviour is preserved.

## The one rule

**A migration that changes what the code does is a defect, even when the new version is
better.** Translation and improvement are separate jobs. Doing both at once makes review
impossible, because a reviewer can no longer tell which differences were intended.

Everything below is that rule applied to the places it usually breaks.

## Rules

**Migrate the bug.** If the source has an off-by-one, a swallowed exception, or a branch that
can never be reached, reproduce it faithfully and note it in your report. Silently fixing it
means the migrated system behaves differently from the one in production, and nobody knows
which of the two is now correct. The fix is a follow-up task with its own review.

**Do not refactor while translating.** No renaming, no reordering, no extracting helpers, no
"while I'm in here". A file that is both translated and restructured cannot be diffed against
its source, which removes the only practical way to verify it.

**Preserve public contracts exactly.** Field names, status codes, error shapes, event names,
queue message formats, CLI flags, environment variable names. Something downstream depends on
each of these, and it is not in this repository. When the source is inconsistent — `_id` here
and `id` there — preserve the inconsistency, or decide once, apply it everywhere, and say so
explicitly in your report.

**Every branch must still end the same way.** Languages differ in how a function returns,
raises, or short-circuits. Walk each conditional in the source and confirm the migrated
version reaches an equivalent outcome for the same input — including the branches that only
exist to handle a failure.

**Ordering is behaviour.** Middleware chains, route matching, event handler registration,
initialisation sequence, `finally` blocks. If the source relied on order — and it usually
does somewhere — the target must reproduce it, even when the target's idiom would naturally
express it differently.

**Concurrency semantics do not survive by accident.** Sequential code becoming concurrent, or
blocking code landing inside an async context, changes behaviour under load without changing
it in any test. Flag every place the execution model differs rather than assuming the
translation is equivalent.

**Never widen access.** Authentication, authorisation, CORS, cookie flags, file permissions,
default visibility. If a check existed in the source, it exists in the target. If you cannot
find where it should go, stop and report it — do not leave it out and mention it in passing.

**Never write a real secret into source.** Not as a literal, and not as a fallback default:
`os.getenv("X", "<real value>")` runs the fallback whenever the variable is unset, which is
often. Read the variable with no default and fail loudly, or use an obviously-fake
placeholder. If you must describe a value in a report, show its shape, never the value.

## Traps

These change behaviour while looking like faithful translations.

| Trap | Why it bites |
| --- | --- |
| Truthiness differs by language | `0`, `""`, `[]` and `null` are not falsy in the same way across languages — a guard silently flips |
| Integer division and rounding | `/` is not the same operator in every language; money and pagination break quietly |
| Default mutable arguments | Shared across calls in some languages, fresh in others |
| String/number coercion | A query param that was a string may arrive coerced, changing a comparison |
| Timezone-naive vs aware datetimes | Values shift by hours with no error |
| Sort stability and comparator semantics | Output order changes for equal keys |
| Exception granularity | A broad catch in the target swallows errors the source let through |
| Early `return` inside a loop vs a callback | Frameworks using callbacks do not stop the enclosing function |
| Null vs undefined vs missing key | Three distinct states in some languages, one in others |

## Done-check

Before calling any file migrated:

- Every branch of every function ends in an equivalent outcome for the same input.
- No public name, status code, or payload shape changed unintentionally.
- Every validation and authorisation check in the source has a counterpart.
- Error handling covers the same failures, no broader and no narrower.
- No secret literal, and no secret as a fallback default.
- Nothing was renamed, reordered, or restructured beyond what the target language requires.
- Anything you could not preserve is named explicitly in your report, not left implicit.
