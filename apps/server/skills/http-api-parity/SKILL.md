---
name: http-api-parity
description: Preserve an HTTP API's observable contract across a framework migration — status codes per branch, response body shapes and key names, error envelopes, headers, route matching order, trailing-slash and query-coercion behaviour. Use when migrating any web API between frameworks or languages, alongside the framework-specific playbook.
allowed-tools: read_file ls glob grep
compatibility: Any HTTP framework, any language.
---

# HTTP API parity

Clients depend on this API's observable behaviour, and those clients are not in this
repository. Framework playbooks cover *how* to express a route in the target; this covers
*what must not change* while you do.

## What "observable" means

Everything a client can see: status code, response body, headers, and which requests match
which handler. If a change is visible to a caller, it is a breaking change — regardless of
how much better the new form is.

## Rules

**Status codes are per-branch, not per-route.** A handler returning 200 on success, 404 when
missing, and 400 on bad input has three contracts. Frameworks that declare a status on the
route decorator make it easy to migrate only the happy path and let every error branch
collapse into the default. Walk each branch individually.

**Distinguish 401 from 403, and 400 from 422.** Source codebases often use these
interchangeably, and target frameworks often have an opinion — FastAPI returns 422 for
validation failures where Express code returned 400. Preserve what the source returned. A
client is branching on it.

**The error envelope is part of the API.** `{"error": "not found"}` and
`{"detail": "not found"}` are different responses. Target frameworks supply their own default
error shape, and adopting it silently changes every error response in the system. If you must
adopt the framework default, say so loudly in your report as a breaking change.

**Key names carry over verbatim.** `_id` stays `_id` unless you decide once, project-wide, to
change it — and then the decision belongs in the rulebook, applied everywhere, and reported.
Field casing (`createdAt` vs `created_at`) is the same problem: target language conventions
are not a reason to rename a wire field.

**Route matching order is behaviour.** A literal route must still be matched before a
parameterised one that could capture it — `/users/me` before `/users/{id}`. Most frameworks
match in declaration order, so preserve the relative order of any pair where one could
shadow the other.

**Serialization must not add or drop fields.** A response model that omits a field the source
returned breaks clients, and one that adds a field can leak data — a password hash included
because the model serialises the whole record. Compare a real response, field by field.

**Optional means optional.** A field the source omitted when absent must not become `null` in
the target, and vice versa. Clients check for both differently.

## Traps

| Trap | What changes |
| --- | --- |
| Trailing slash | Some frameworks redirect `/items` → `/items/` with a 307; the source may have served both directly |
| Query param coercion | `?page=2` arriving as `int` vs `str` changes comparisons and error messages |
| Repeated query params | `?tag=a&tag=b` becomes a list in some frameworks, last-wins in others |
| Empty body vs `null` body | 204 with no body is not 200 with `null` |
| Header name casing | Case-insensitive over the wire, but not always in the code reading them |
| Content-Type on errors | An error returned as `text/plain` where the source sent JSON breaks client parsing |
| Large-number precision | 64-bit ids serialised as JSON numbers lose precision; the source may have sent strings |
| Date format | ISO-8601 with and without timezone, or epoch seconds vs milliseconds |
| Implicit 500 body | Target framework may include a stack trace where the source returned a generic message |

## Method

1. Build a list of every route in the source: method, path, and each branch's status code and
   body shape.
2. Migrate, then rebuild the same list from the target.
3. Compare them row by row. Differences are either intentional and reported, or defects.

Where tests exist, they are the cheapest form of this list — read what they assert about
status codes and payloads before trusting your own reading of the handler.

## Done-check

- Every route's every branch returns the same status code as the source.
- Response body keys match exactly, including casing and `_id`-style names.
- The error envelope shape is unchanged for every error path.
- No field added to or removed from any response.
- Literal routes still precede parameterised routes that could capture them.
- Trailing-slash and repeated-query-param behaviour matches, or the difference is reported.
