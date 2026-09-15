# Express auth → FastAPI

Read this only when the file under conversion performs authentication or authorisation.
Most route files do not, which is why it is here rather than in `SKILL.md`.

## The shape of the problem

Express auth is middleware that runs before the handler and attaches something to `req`.
FastAPI has no `req` to attach to — a dependency *returns* the value and the handler declares
it as a parameter. So the translation is always: **what did this middleware put on `req`, and
which handlers need it?**

```js
// Express
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "unauthorized" });
  req.user = verify(token);
  next();
}
router.get("/me", requireAuth, (req, res) => res.json(req.user));
```

```python
# FastAPI
async def current_user(authorization: Annotated[str | None, Header()] = None) -> User:
    token = authorization.removeprefix("Bearer ").strip() if authorization else None
    if not token:
        raise HTTPException(status_code=401, detail="unauthorized")
    return verify(token)

@router.get("/me")
async def me(user: Annotated[User, Depends(current_user)]) -> User:
    return user
```

## Rules

**One dependency per thing attached to `req`.** Middleware that sets `req.user` *and*
`req.tenant` becomes two dependencies, unless the second genuinely cannot be computed without
the first — in which case the second depends on the first. Merging them forces handlers to
receive data they do not use.

**Router-level middleware becomes a router-level dependency.** `router.use(requireAuth)`
maps to `APIRouter(dependencies=[Depends(current_user)])`. Use that form when no handler
needs the *value*; use a parameter when they do. Getting this wrong silently drops the check
from routes that had it.

**401 and 403 are not interchangeable.** Express codebases frequently return 401 for both
"not authenticated" and "not allowed". Preserve whatever the source actually returned, even
when it is wrong — a client is depending on it. Note it in your report rather than fixing it.

**Ordering is authorisation.** `router.use(requireAuth); router.use(requireAdmin);` means
admin is checked only after auth. When `requireAdmin` assumes `req.user` exists, the FastAPI
equivalent must depend on `current_user` rather than re-reading the header, or an
unauthenticated request reaches the admin check and fails with the wrong status.

**Optional auth needs an explicit optional dependency.** Express routes that behave
differently for logged-in users usually read `req.user` and check for undefined. That becomes
a dependency returning `User | None`, not a second route.

## Traps

- `req.user` set by middleware but never used by a handler means the middleware existed for
  its *side effect* — a 401 — so the dependency must stay even with nothing to return.
- Express error middleware `(err, req, res, next)` catching auth failures becomes
  `@app.exception_handler`, not a `try/except` in each handler.
- A token read from a cookie rather than a header needs `Cookie()`, and the cookie name is
  part of the client contract — do not rename it.
- `next('route')` skipping to the next matching route has no FastAPI equivalent. Flag it
  rather than approximating; the behaviour has to be restructured deliberately.

## Done-check

- Every route that had an auth middleware in the chain has an equivalent dependency.
- Status codes match the source for both the missing-credential and invalid-credential paths.
- Nothing that was router-wide became per-route, or vice versa.
- No handler reads a header directly that a dependency should be supplying.
