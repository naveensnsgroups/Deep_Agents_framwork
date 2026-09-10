---
name: jest-to-pytest
description: Convert Jest, Mocha, or Supertest suites to pytest — lifecycle hooks, assertions, mocks, async tests, fixtures, and HTTP endpoint tests for FastAPI. Use when migrating JavaScript tests to Python, or when writing pytest coverage for endpoints that were previously tested with Supertest.
allowed-tools: read_file write_file edit_file ls glob grep execute
compatibility: pytest 8.x, pytest-asyncio, pytest-mock, httpx (ASGITransport), FastAPI TestClient
---

# Jest / Supertest → pytest

A migrated test suite is only evidence if it still asserts the same things. Translate what
each test checks; do not rewrite the intent, and do not quietly drop a case that is
awkward to express.

## Mapping

| Jest | pytest |
| --- | --- |
| `describe("X", ...)` | `class TestX:` or just module grouping |
| `it/test("does y")` | `def test_does_y():` |
| `beforeEach` | function-scoped fixture |
| `beforeAll` | module/session-scoped fixture |
| `afterEach` / `afterAll` | `yield` in the fixture, teardown after |
| `expect(a).toBe(b)` | `assert a is b` (identity) |
| `expect(a).toEqual(b)` | `assert a == b` |
| `expect(a).toBeTruthy()` | `assert a` |
| `expect(f).toThrow(E)` | `with pytest.raises(E):` |
| `test.each([...])` | `@pytest.mark.parametrize` |
| `jest.fn()` | `unittest.mock.MagicMock()` |
| `jest.spyOn(o, "m")` | `mocker.patch.object(o, "m")` |
| `jest.mock("mod")` | `mocker.patch("module.path")` |

`toBe` is identity and `toEqual` is deep equality — in Python `==` covers the deep case
and `is` the identity one. Using `is` for value comparison passes by accident on small
ints and interned strings, then fails later; keep the distinction deliberate.

## Supertest → FastAPI test client

`request(app).get("/x").expect(200)` becomes a `TestClient` (sync) or `httpx.AsyncClient`
with `ASGITransport` (async) call plus explicit assertions:

- Assert the status code and the response body separately — Supertest chains hide which
  one actually failed.
- Keep asserting the same response keys. If the migration renamed a field, that is a
  finding to report, not something to silently update the test to match.

Async tests need `pytest-asyncio` and `@pytest.mark.asyncio` (or `asyncio_mode = auto` in
config). A coroutine that is never awaited reports as a *passing* test while asserting
nothing — check that async tests can actually fail.

## Mocking

Patch where the object is **used**, not where it is defined: if `routes.py` does
`from db import get_user`, patch `routes.get_user`. Patching `db.get_user` after the
import has already bound the name has no effect and the test passes against real code.

Prefer `pytest-mock`'s `mocker` fixture so patches unwind automatically.

## Fixtures

Jest's `beforeEach` implicitly shares state through closure variables; pytest passes
fixtures in explicitly as arguments. Make each fixture return what the test needs rather
than mutating module-level state, and pick the narrowest scope that still works —
a session-scoped fixture holding mutable state reintroduces the cross-test coupling the
translation was supposed to remove.

Database-touching tests must clean up in fixture teardown (after `yield`) so a failing
test does not poison the next one.

## Before declaring the test migration done

- Every original test has a counterpart, or its absence is reported explicitly.
- Each assertion checks the same property as the original, with the same expected values.
- Async tests are genuinely awaited — confirm by making one fail on purpose.
- Mock targets reference the importing module's namespace.
- The suite has actually been run, and the report states the real pass/fail counts.
