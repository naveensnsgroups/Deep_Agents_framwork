---
name: express-to-fastapi
description: Convert an Express.js HTTP layer to FastAPI — routers, middleware, request validation, error handling, auth, and async patterns. Use when migrating a Node/Express REST API to Python FastAPI, or when converting individual Express route files, controllers, or middleware to FastAPI equivalents.
allowed-tools: read_file write_file edit_file ls glob grep
compatibility: FastAPI 0.110+, Python 3.11+, Pydantic v2
---

# Express.js → FastAPI

## Structural mapping

| Express | FastAPI |
| --- | --- |
| `express()` app | `FastAPI()` app |
| `express.Router()` | `APIRouter(prefix=..., tags=[...])` |
| `app.use("/api/x", router)` | `app.include_router(router, prefix="/api/x")` |
| `req.params.id` | path param `id: str` in the signature |
| `req.query.page` | query param `page: int = 1` |
| `req.body` | Pydantic model parameter |
| `res.status(201).json(x)` | `return x` + `status_code=201` on the decorator |
| `next(err)` | `raise HTTPException(...)` |
| middleware | dependency (`Depends`) or `@app.middleware("http")` |
| `app.listen(port)` | uvicorn entrypoint |

## Rules

**Return, don't send.** Express writes to a response object; FastAPI returns a value. A
handler that sends inside a branch and then keeps executing must become an explicit
`return` or `raise` in each branch — Express bugs where code ran after `res.json()` do not
survive translation, so fix them rather than copying the shape.

**Status codes live on the decorator.** `res.status(201)` becomes
`@router.post("/", status_code=201)`. A status that varies by branch needs
`JSONResponse(status_code=..., content=...)` or an `HTTPException`.

**Route order does not carry over.** Express matches in declaration order, so `/users/me`
must precede `/users/:id`. FastAPI matches the same way, so preserve the relative order of
any literal route that could be captured by a parameterised one; note it explicitly when
the source relied on it.

**Middleware usually becomes a dependency.** Anything that reads the request, validates,
and attaches something for later handlers (auth, tenant lookup, rate-limit identity) is a
`Depends(...)` returning that value. Reserve `@app.middleware("http")` for things that
genuinely wrap every request end to end, such as request logging or CORS-adjacent work.
Use `CORSMiddleware` for the `cors` package rather than hand-writing headers.

**Error handling becomes exceptions.** An Express error middleware
(`(err, req, res, next)`) becomes either `HTTPException` at the raise site or an
`@app.exception_handler(SomeError)`. Preserve the exact status codes and the response body
shape the client already depends on — do not "improve" an error payload during migration.

**Async is not optional.** Mongo, HTTP calls, and file I/O must use async drivers inside
`async def`. A blocking call inside `async def` stalls the event loop; if a sync-only
library is unavoidable, use `def` for that handler (FastAPI runs it in a threadpool) and
say so in your report.

## Validation

Express hand-rolls validation or uses Zod/Joi; FastAPI does it with Pydantic models
declared as parameters. Move every check into the model rather than leaving imperative
`if (!x) return res.status(400)` guards in the handler. See `mongoose-to-pydantic-motor`
for translating schema-level constraints.

Use separate models for input and output when the source distinguishes them — a create
body that omits `_id`/timestamps is a different model from what the endpoint returns, and
`response_model` is what strips fields such as password hashes.

## What to check before declaring a route done

- Every branch of the original handler ends in a `return` or `raise`.
- Status codes match the original for both success and every error path.
- The response JSON keys match exactly — including the `_id` vs `id` decision, which must
  be made once and applied everywhere.
- Anything the Express middleware chain attached to `req` is now supplied by a dependency.
- No blocking I/O inside `async def`.
