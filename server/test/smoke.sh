#!/usr/bin/env bash
# End-to-end smoke test for the Folio conversion API.
# Runs real conversions through a running server (normally the Docker image)
# and checks each output's magic bytes, then checks the error responses.
#
# Usage: bash server/test/smoke.sh [BASE_URL]   (default http://localhost:8080)
# Needs: curl, jq, od, head, dd
set -euo pipefail

BASE="${1:-http://localhost:8080}"
BASE="${BASE%/}"
POLL_LIMIT_S="${POLL_LIMIT_S:-180}"

for tool in curl jq od dd head; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: '$tool' is required" >&2; exit 2; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
FAILED_NAMES=()
LAST_JOB=""
LAST_ERR=""

err() { LAST_ERR="$*"; }

pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s\n' "$1"; }
fail() {
  FAILED=$((FAILED + 1)); FAILED_NAMES+=("$1")
  printf 'FAIL  %s: %s\n' "$1" "${2:-$LAST_ERR}"
}

# Hex dump of <count> bytes of <file> starting at <offset>.
hex_at() { od -An -tx1 -j "${3:-0}" -N "$2" "$1" 2>/dev/null | tr -d ' \n'; }

# check_magic <file> <kind>
check_magic() {
  local file=$1 kind=$2 got want offset=0 len
  [ -s "$file" ] || { err "output is missing or empty"; return 1; }
  case "$kind" in
    zip)  want=504b0304 ;;                  # PK\3\4 (EPUB, DOCX)
    pdf)  want=25504446 ;;                  # %PDF
    mobi) want=424f4f4b4d4f4249; offset=60 ;; # BOOKMOBI (MOBI, AZW3)
    doc)  want=d0cf11e0a1b11ae1 ;;          # OLE2 compound file
    *) err "unknown magic kind $kind"; return 1 ;;
  esac
  len=$(( ${#want} / 2 ))
  got=$(hex_at "$file" "$len" "$offset")
  if [ "$got" != "$want" ]; then
    err "bad magic bytes for $kind at offset $offset: got '$got', want '$want'"
    return 1
  fi
}

# post <file> <TO> -> sets POST_CODE and writes the body to $TMP/post.json
post() {
  local file=$1 to=$2
  POST_CODE=$(curl -sS -o "$TMP/post.json" -w '%{http_code}' \
    -F "to=$to" -F "file=@$file" "$BASE/api/convert" 2>"$TMP/curl.err") || {
    # The server may close the connection while a too-large upload is still
    # being sent; keep whatever status curl managed to read.
    POST_CODE=${POST_CODE:-000}
  }
  [ -n "$POST_CODE" ] || POST_CODE=000
}

# convert <in> <TO> <out>: upload, poll the job, download the result.
convert() {
  local in=$1 to=$2 out=$3 id status job waited=0
  [ -s "$in" ] || { err "input $in is missing (an earlier step failed)"; return 1; }

  post "$in" "$to"
  if [ "$POST_CODE" != 202 ]; then
    err "POST /api/convert returned $POST_CODE: $(cat "$TMP/post.json" 2>/dev/null) $(cat "$TMP/curl.err" 2>/dev/null)"
    return 1
  fi
  id=$(jq -r '.id // empty' "$TMP/post.json")
  [ -n "$id" ] || { err "no job id in response: $(cat "$TMP/post.json")"; return 1; }
  LAST_JOB=$id

  while :; do
    if ! job=$(curl -fsS "$BASE/api/jobs/$id" 2>"$TMP/curl.err"); then
      err "GET /api/jobs/$id failed: $(cat "$TMP/curl.err")"
      return 1
    fi
    status=$(jq -r '.status' <<<"$job")
    case "$status" in
      done) break ;;
      error) err "job $id failed: $(jq -r '.error // "unknown error"' <<<"$job")"; return 1 ;;
      queued|converting) ;;
      *) err "unexpected job status '$status': $job"; return 1 ;;
    esac
    if [ "$waited" -ge "$POLL_LIMIT_S" ]; then
      err "job $id still '$status' after ${POLL_LIMIT_S}s"
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if ! curl -fsS -o "$out" "$BASE/api/jobs/$id/download" 2>"$TMP/curl.err"; then
    err "download of job $id failed: $(cat "$TMP/curl.err")"
    return 1
  fi
}

# case_convert <name> <in> <TO> <out> <magic>
case_convert() {
  local name=$1 in=$2 to=$3 out=$4 magic=$5 start=$SECONDS
  if convert "$in" "$to" "$out" && check_magic "$out" "$magic"; then
    pass "$name ($(( SECONDS - start ))s, $(wc -c <"$out" | tr -d ' ') bytes)"
  else
    rm -f "$out"
    fail "$name"
  fi
}

# case_reject <name> <file> <TO> <expected status>
case_reject() {
  local name=$1 file=$2 to=$3 want=$4
  if [ ! -s "$file" ]; then fail "$name" "input $file is missing"; return; fi
  post "$file" "$to"
  if [ "$POST_CODE" = "$want" ]; then
    local msg
    msg=$(jq -r '.error // empty' "$TMP/post.json" 2>/dev/null || true)
    pass "$name${msg:+ ($msg)}"
  else
    fail "$name" "expected $want, got $POST_CODE: $(head -c 300 "$TMP/post.json" 2>/dev/null)"
  fi
}

echo "Folio smoke test against $BASE"

# --- health -----------------------------------------------------------------
if health=$(curl -fsS "$BASE/api/health" 2>"$TMP/curl.err") \
   && [ "$(jq -r '.ok' <<<"$health")" = true ]; then
  pass "GET /api/health: $health"
else
  fail "GET /api/health" "${health:-$(cat "$TMP/curl.err")}"
fi

# --- sample book --------------------------------------------------------------
B="$TMP/book"
mkdir -p "$B"
cat >"$B/sample.txt" <<'EOF'
The Folio Smoke Test

Chapter 1

It was a quiet morning when the converter woke up. The queue was empty, the
disk was clean, and somewhere a PDF was waiting to become something better.

Every paragraph in this little book exists to make sure text survives the
trip between formats: EPUB, PDF, MOBI, AZW3, DOCX and DOC, and back again.

Chapter 2

The second chapter is shorter. It checks that headings are kept, that
punctuation such as "quotes", dashes - and apostrophes' survive, and that the
last line arrives intact.

The end.
EOF

# --- conversion chain -------------------------------------------------------
case_convert "TXT -> EPUB"  "$B/sample.txt" EPUB "$B/s1.epub"  zip
case_convert "EPUB -> PDF"  "$B/s1.epub"    PDF  "$B/s2.pdf"   pdf
case_convert "PDF -> EPUB"  "$B/s2.pdf"     EPUB "$B/s3.epub"  zip
case_convert "EPUB -> MOBI" "$B/s3.epub"    MOBI "$B/s4.mobi"  mobi
case_convert "MOBI -> AZW3" "$B/s4.mobi"    AZW3 "$B/s5.azw3"  mobi
case_convert "AZW3 -> DOCX" "$B/s5.azw3"    DOCX "$B/s6.docx"  zip
case_convert "DOCX -> PDF"  "$B/s6.docx"    PDF  "$B/s7.pdf"   pdf
case_convert "DOCX -> DOC"  "$B/s6.docx"    DOC  "$B/s8.doc"   doc
case_convert "DOC -> EPUB"  "$B/s8.doc"     EPUB "$B/s9.epub"  zip
case_convert "EPUB -> DOC"  "$B/s1.epub"    DOC  "$B/s10.doc"  doc
case_convert "TXT -> DOCX"  "$B/sample.txt" DOCX "$B/s11.docx" zip
FINISHED_JOB=$LAST_JOB

# --- rejections ---------------------------------------------------------------
# A PNG renamed to .pdf must be caught by the magic-byte check.
printf '\211PNG\r\n\032\n\000\000\000\rIHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211' \
  >"$B/image.pdf"
case_reject "PNG renamed .pdf -> 415" "$B/image.pdf" EPUB 415

case_reject "same format (EPUB -> EPUB) -> 400" "$B/s1.epub" EPUB 400

# 51 MB of plain text, just over the 50 MB default limit.
yes 'All work and no play makes a very large test file.' | head -c $((51 * 1024 * 1024)) >"$B/big.txt" || true
case_reject "51 MB upload -> 413" "$B/big.txt" EPUB 413
rm -f "$B/big.txt"

# --- delete -------------------------------------------------------------------
if [ -z "$FINISHED_JOB" ]; then
  fail "DELETE finished job -> 204" "no job id available"
  fail "GET deleted job -> 404" "no job id available"
else
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/jobs/$FINISHED_JOB" || echo 000)
  if [ "$code" = 204 ]; then pass "DELETE finished job -> 204"; else fail "DELETE finished job -> 204" "got $code"; fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/jobs/$FINISHED_JOB" || echo 000)
  if [ "$code" = 404 ]; then pass "GET deleted job -> 404"; else fail "GET deleted job -> 404" "got $code"; fi
fi

# --- summary ------------------------------------------------------------------
echo
echo "Passed: $PASSED  Failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then
  printf '  failed: %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi
echo "All smoke tests passed."
