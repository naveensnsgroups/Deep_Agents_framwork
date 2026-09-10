---
name: mongoose-to-pydantic-motor
description: Convert Mongoose models and queries to Python Pydantic models with Motor or PyMongo, keeping the same MongoDB collections and documents. Use when migrating a Node/Mongoose data layer to Python while staying on MongoDB (including MongoDB Atlas), covering schema constraints, ObjectId handling, queries, and indexes.
allowed-tools: read_file write_file edit_file ls glob grep
compatibility: MongoDB 6+/Atlas, Motor 3.x, PyMongo 4.x, Pydantic v2, bson
---

# Mongoose → Pydantic + Motor

The database is not being migrated — the same collections and documents keep serving live
data. Only the code that reads them changes, so every field name and type in the existing
documents must survive exactly.

## Mapping

| Mongoose | Python |
| --- | --- |
| `mongoose.connect(uri)` | `AsyncIOMotorClient(uri)` |
| `mongoose.Schema({...})` | Pydantic `BaseModel` |
| `mongoose.model("Employee", s)` | `db["employees"]` collection handle |
| `Model.find(q)` | `await coll.find(q).to_list(n)` |
| `Model.findById(id)` | `await coll.find_one({"_id": ObjectId(id)})` |
| `Model.create(doc)` | `await coll.insert_one(doc)` |
| `findByIdAndUpdate` | `await coll.find_one_and_update(...)` |
| `findByIdAndDelete` | `await coll.find_one_and_delete(...)` |
| `Model.countDocuments(q)` | `await coll.count_documents(q)` |

## The collection name is not guessable

Mongoose pluralises and lowercases a model name to derive the collection
(`Employee` → `employees`), but `mongoose.model("Employee", schema, "HR")` and
`{ collection: "HR" }` both override it. Read the actual model registration and use the
literal collection name it resolves to. Guessing here silently reads an empty collection
in production.

## ObjectId

`_id` is a BSON `ObjectId`, not a string. Convert on the way in and out:

- Incoming path/query params are strings — wrap with `ObjectId(id)` for the filter, and
  return a clear 400/404 instead of letting `bson.errors.InvalidId` escape as a 500.
- Outgoing documents need `_id` stringified before JSON encoding.
- Decide `_id` vs `id` in the response body **once**. If the existing API returns `_id`,
  keep returning `_id` — renaming it breaks every client.

Any field that stores a reference (Mongoose `ref`) is also an ObjectId and needs the same
treatment.

## Constraint translation

| Mongoose | Pydantic |
| --- | --- |
| `required: true` | field with no default |
| not required | `Optional[T] = None` |
| `default: v` | `= v` (use `default_factory` for mutable/dynamic) |
| `enum: [...]` | `Literal[...]` or an `Enum` |
| `min` / `max` | `Field(ge=..., le=...)` |
| `minlength` / `maxlength` | `Field(min_length=..., max_length=...)` |
| `match: /re/` | `Field(pattern=...)` |
| `trim: true` | validator that strips |
| `lowercase: true` | validator that lowercases |
| `unique: true` | **not validation** — a database index |

`unique: true` is the one that gets lost. Mongoose only enforces it if the index exists in
the database; it is not a schema check. Do not emulate it with a pre-insert `find_one`
(that is a race). Keep relying on the existing index and translate the resulting
`DuplicateKeyError` into the same status code the Express app returned.

`timestamps: true` adds `createdAt`/`updatedAt` automatically — Motor does not. Set them
explicitly on insert and update, using the exact field names already in the documents.

## Validation must stay as strict as it was

Mongoose validators run on save. Pydantic validates at the API boundary. That is
equivalent only if every write path goes through the model — so construct the Pydantic
model before writing, and dump from it, rather than passing a raw dict to `insert_one`.

Use `model_dump(exclude_none=True)` on partial updates so an omitted field is left alone
instead of being overwritten with `None`.

## Connection handling

Open one client for the process lifetime (FastAPI lifespan handler), not per request.
Read the URI from the environment with no fallback value — never inline a real connection
string as a default, even a "test" one.

## Before declaring the data layer done

- The collection name matches the Mongoose registration, including any explicit override.
- Every `_id` and every `ref` field converts in both directions.
- Required/optional matches the original schema field by field.
- `timestamps` fields are written with the same names as the existing documents.
- Unique constraints are still enforced by the index, and its error maps to the old status.
