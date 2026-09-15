#!/bin/sh
# Finds Express constructs that should no longer exist in converted Python.
#
# A deterministic sweep beats asking the model to remember to look: it costs no context, it
# cannot get bored two hundred files into a migration, and it catches the specific failure
# this conversion produces — a handler translated in shape but still writing to a response
# object, or still ending a branch without returning.
#
# Usage:  sh find-unconverted.sh <directory>
# Exits 0 when clean, 1 when anything is found, so a verifier can branch on it.

DIR="${1:-.}"

if [ ! -d "$DIR" ]; then
  echo "not a directory: $DIR" >&2
  exit 2
fi

found=0

report() {
  # $1 = label, $2 = grep pattern
  matches=$(grep -rnE "$2" "$DIR" --include='*.py' 2>/dev/null)
  if [ -n "$matches" ]; then
    echo "== $1"
    echo "$matches"
    echo
    found=1
  fi
}

# Response-object writes that survived translation verbatim. FastAPI returns a value.
report "res.* calls left in Python" 'res\.(json|send|status|end|sendStatus)\('

# Express's error-passing convention. Should be `raise HTTPException(...)`.
report "next(err) left in Python" '\bnext\(\s*(err|error)'

# Express path params. FastAPI uses {id}, and a leftover :id silently never matches.
report "Express-style path params in a route decorator" '@(app|router)\.(get|post|put|patch|delete)\(\s*[\x27"][^\x27"]*:[a-zA-Z_]'

# Blocking client inside async def — stalls the whole event loop rather than erroring.
report "requests library inside an async project" '^\s*import requests|^\s*from requests import'

# Mongoose leftovers when the data layer was converted alongside. Matched by their camelCase
# names, which no Python data layer uses — PyMongo and Motor spell these `find_one`. The
# arguments are not constrained: an earlier version required empty parens and so missed every
# real call, all of which take an id.
report "Mongoose calls left in Python" '\.(findById|findOne|findByIdAndUpdate|findByIdAndDelete|findOneAndUpdate|findOneAndDelete)\('

if [ "$found" -eq 0 ]; then
  echo "clean: no unconverted Express constructs found in $DIR"
fi

exit "$found"
