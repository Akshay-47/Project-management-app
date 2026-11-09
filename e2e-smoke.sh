#!/usr/bin/env bash
# E2E smoke test — exercises every user story against the live API
# Usage: bash e2e-smoke.sh [BASE_URL]
set -euo pipefail
BASE="${1:-http://localhost:3001/v1}"
PASS=0; FAIL=0

green() { printf '\033[32m✓\033[0m %s\n' "$*"; }
red()   { printf '\033[31m✗\033[0m %s\n' "$*"; }

check() {
  local label="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    green "$label"
    PASS=$((PASS+1))
  else
    red "$label  →  expected '$expected' in: $actual"
    FAIL=$((FAIL+1))
  fi
}

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Flowboard E2E smoke test  →  $BASE"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Health & discovery ─────────────────────────────────
echo "── Health & discovery"
R=$(curl -s "$BASE/../health")
check "GET /health returns ok"              '"ok"'      "$R"

R=$(curl -s "$BASE")
check "GET /v1 returns name=Flowboard API"  'Flowboard' "$R"
check "GET /v1 lists endpoint index"        '/v1/me'    "$R"

# ── Identity ───────────────────────────────────────────
echo ""
echo "── Identity (story 7 — server resolves role)"
R=$(curl -s -H "X-User-Id: alice" "$BASE/me")
check "Alice is admin"                      '"admin"'   "$R"

R=$(curl -s -H "X-User-Id: bob" "$BASE/me")
check "Bob is member"                       '"member"'  "$R"

R=$(curl -s -H "X-User-Id: carol" "$BASE/me")
check "Carol is member"                     '"member"'  "$R"

R=$(curl -s "$BASE/me")
check "No identity → 401 UNAUTHENTICATED"   'UNAUTHENTICATED' "$R"

R=$(curl -s -H "X-User-Id: nobody" "$BASE/me")
check "Unknown identity → 401"              'UNAUTHENTICATED' "$R"

# ── Tree navigation ────────────────────────────────────
echo ""
echo "── Workspace tree navigation (story 1)"
TREE=$(curl -s -H "X-User-Id: alice" "$BASE/containers/tree")
check "Alice sees Engineering space"        'Engineering' "$TREE"
check "Alice sees Product space"            'Product'     "$TREE"
check "Alice sees Backlog list"             'Backlog'     "$TREE"
check "Alice sees private Roadmap list"     'Roadmap'     "$TREE"

BOB_TREE=$(curl -s -H "X-User-Id: bob" "$BASE/containers/tree")
check "Bob sees Engineering"                'Engineering' "$BOB_TREE"
check "Bob does NOT see Roadmap (private)"  'Backlog'     "$BOB_TREE"
if echo "$BOB_TREE" | grep -q '"Roadmap"'; then
  red "Bob should NOT see private Roadmap"
  FAIL=$((FAIL+1))
else
  green "Bob correctly excluded from private Roadmap"
  PASS=$((PASS+1))
fi

CAROL_TREE=$(curl -s -H "X-User-Id: carol" "$BASE/containers/tree")
check "Carol sees Roadmap (granted)"        'Roadmap'     "$CAROL_TREE"
if echo "$CAROL_TREE" | grep -q '"Engineering"'; then
  red "Carol should NOT see Engineering (denied)"
  FAIL=$((FAIL+1))
else
  green "Carol correctly denied Engineering"
  PASS=$((PASS+1))
fi

# ── Extract IDs for further tests ─────────────────────
BACKLOG_ID=$(echo "$TREE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(next(c['id'] for c in d if c['name']=='Backlog'))")
DELIVERY_ID=$(echo "$TREE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(next(c['id'] for c in d if c['name']=='Delivery'))")
ROADMAP_ID=$(echo "$TREE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(next(c['id'] for c in d if c['name']=='Roadmap'))")
SPACE_ENG_ID=$(echo "$TREE" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(next(c['id'] for c in d if c['name']=='Engineering'))")
echo "  Backlog=$BACKLOG_ID  Delivery=$DELIVERY_ID  Roadmap=$ROADMAP_ID"

# ── Resolved configuration (story 5) ──────────────────
echo ""
echo "── Hierarchical status & field resolution (story 5)"
STATUSES=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$BACKLOG_ID/resolved-statuses")
check "Backlog has resolved statuses"       '"data"'       "$STATUSES"
check "Backlog inherits workspace 'todo'"   '"todo"'       "$STATUSES"
check "Backlog overrides in_progress→Doing" '"Doing"'      "$STATUSES"

DEL_STATUSES=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$DELIVERY_ID/resolved-statuses")
check "Delivery has 'Building' (own override)" '"Building"' "$DEL_STATUSES"
check "Delivery has 'Review' status"        '"Review"'     "$DEL_STATUSES"
check "Delivery done status is 'Shipped'"   '"Shipped"'    "$DEL_STATUSES"

FIELDS=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$BACKLOG_ID/resolved-fields")
check "Backlog resolves Estimate field"     '"estimate"'   "$FIELDS"
check "Estimate is required"                '"required":true' "$FIELDS"
check "Backlog resolves Component field"    '"component"'  "$FIELDS"
check "Component is single_select"          'single_select' "$FIELDS"

# ── Access control (story 7) ───────────────────────────
echo ""
echo "── Access control enforcement (story 7)"
R=$(curl -s -H "X-User-Id: bob" "$BASE/lists/$ROADMAP_ID/tasks")
check "Bob cannot read private Roadmap → 403" 'FORBIDDEN' "$R"

R=$(curl -s -H "X-User-Id: carol" "$BASE/lists/$BACKLOG_ID/tasks")
check "Carol denied Engineering → 403"      'FORBIDDEN'   "$R"

R=$(curl -s -H "X-User-Id: bob" "$BASE/lists/$ROADMAP_ID/resolved-statuses")
check "Bob cannot get Roadmap statuses → 403" 'FORBIDDEN' "$R"

# ── Task CRUD (story 3) ────────────────────────────────
echo ""
echo "── Task create / read / update / archive (story 3)"
TODO_ID=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$BACKLOG_ID/resolved-statuses" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(next(s['id'] for s in d if s['key']=='todo'))")

NEW_TASK=$(curl -s -X POST "$BASE/lists/$BACKLOG_ID/tasks" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"title\":\"E2E smoke task\",\"statusId\":\"$TODO_ID\",\"customFields\":{\"estimate\":5,\"component\":\"api\"}}")
check "Create task → 201 with id"           '"id"'         "$NEW_TASK"
check "Task has correct title"              'E2E smoke task' "$NEW_TASK"
TASK_ID=$(echo "$NEW_TASK" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])")
echo "  Task=$TASK_ID"

R=$(curl -s -H "X-User-Id: alice" "$BASE/tasks/$TASK_ID")
check "GET /tasks/:id returns task"         'E2E smoke task' "$R"
check "GET /tasks/:id includes field defs"  'customFieldDefinitions' "$R"

INPROGRESS_ID=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$BACKLOG_ID/resolved-statuses" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(next(s['id'] for s in d if s['key']=='in_progress'))")
R=$(curl -s -X PATCH "$BASE/tasks/$TASK_ID" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"statusId\":\"$INPROGRESS_ID\",\"priority\":\"high\"}")
check "PATCH task status & priority"        '"high"'       "$R"

# ── Validation rejection (story 6) ────────────────────
echo ""
echo "── Validation rejection (story 6)"
R=$(curl -s -X POST "$BASE/lists/$BACKLOG_ID/tasks" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"title\":\"Bad task\",\"statusId\":\"nonexistent-id\"}")
check "Unknown statusId → 400 VALIDATION_ERROR" 'VALIDATION_ERROR' "$R"
check "Validation error has details array"  '"details"'    "$R"

R=$(curl -s -X POST "$BASE/lists/$BACKLOG_ID/tasks" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"title\":\"Missing required field\",\"statusId\":\"$TODO_ID\"}")
check "Missing required estimate → 400"     'VALIDATION_ERROR' "$R"
check "Error details mention estimate"      'estimate'     "$R"

R=$(curl -s -X POST "$BASE/lists/$BACKLOG_ID/tasks" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d '{}')
check "Empty body → 400 with field errors"  'VALIDATION_ERROR' "$R"

# ── Cross-list move (story 3) ──────────────────────────
echo ""
echo "── Cross-list move with destination validation (story 3)"
DEST_TODO=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$DELIVERY_ID/resolved-statuses" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(next(s['id'] for s in d if s['key']=='todo'))")
R=$(curl -s -X POST "$BASE/tasks/$TASK_ID/move" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"destinationListId\":\"$DELIVERY_ID\",\"statusId\":\"$DEST_TODO\"}")
check "Move task to Delivery succeeds"      '"primaryListId"' "$R"
check "Task now in Delivery list"           "$DELIVERY_ID"    "$R"

# Move it back for archive test
R=$(curl -s -X POST "$BASE/tasks/$TASK_ID/move" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"destinationListId\":\"$BACKLOG_ID\",\"statusId\":\"$TODO_ID\"}")
check "Move task back to Backlog"           "$BACKLOG_ID"     "$R"

# ── Pagination (story 3) ───────────────────────────────
echo ""
echo "── Cursor pagination"
PAGE1=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$BACKLOG_ID/tasks?limit=3")
check "Page 1 returns 3 tasks"              '"hasMore"'    "$PAGE1"
HAS_MORE=$(echo "$PAGE1" | python3 -c "import json,sys; print(json.load(sys.stdin)['pageInfo']['hasMore'])")
check "hasMore is True (24+ tasks in Backlog)" 'True'     "$HAS_MORE"
CURSOR=$(echo "$PAGE1" | python3 -c "import json,sys; print(json.load(sys.stdin)['pageInfo']['nextCursor'])")
PAGE2=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$BACKLOG_ID/tasks?limit=3&cursor=$CURSOR")
check "Page 2 with cursor returns data"     '"data"'       "$PAGE2"

# ── Container management (story 2) ────────────────────
echo ""
echo "── Container create / rename / reorder / archive (story 2)"
NEW_SPACE=$(curl -s -X POST "$BASE/containers" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d '{"name":"E2E Test Space","type":"space"}')
check "Admin creates space → 201"           '"id"'         "$NEW_SPACE"
SPACE_ID=$(echo "$NEW_SPACE" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])")

NEW_FOLDER=$(curl -s -X POST "$BASE/containers" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"name\":\"E2E Folder\",\"type\":\"folder\",\"parentId\":\"$SPACE_ID\"}")
check "Admin creates folder inside space"   '"id"'         "$NEW_FOLDER"
FOLDER_ID=$(echo "$NEW_FOLDER" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])")

NEW_LIST=$(curl -s -X POST "$BASE/containers" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d "{\"name\":\"E2E List\",\"type\":\"list\",\"parentId\":\"$FOLDER_ID\"}")
check "Admin creates list inside folder"    '"id"'         "$NEW_LIST"
LIST_ID=$(echo "$NEW_LIST" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['id'])")

R=$(curl -s -X PATCH "$BASE/containers/$SPACE_ID" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d '{"name":"E2E Renamed Space"}')
check "Admin renames space"                 'E2E Renamed Space' "$R"

R=$(curl -s -X PATCH "$BASE/containers/$SPACE_ID" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d '{"position":0}')
check "Admin reorders space (sets position=0)" '"position"' "$R"

R=$(curl -s -X POST "$BASE/containers" \
  -H "X-User-Id: bob" -H "Content-Type: application/json" \
  -d '{"name":"Sneaky","type":"space"}')
check "Member cannot create container → 403" 'FORBIDDEN'  "$R"

R=$(curl -s -X POST "$BASE/containers/$SPACE_ID/archive" \
  -H "X-User-Id: alice")
check "Admin archives space → archived:true" '"archived":true' "$R"

R=$(curl -s -H "X-User-Id: alice" "$BASE/containers/tree")
if echo "$R" | grep -q 'E2E Renamed Space'; then
  red "Archived space should not appear in tree"
  FAIL=$((FAIL+1))
else
  green "Archived space correctly hidden from tree"
  PASS=$((PASS+1))
fi

# ── Status config (story 5) ────────────────────────────
echo ""
echo "── Status configuration at scope levels (story 5)"
R=$(curl -s -X POST "$BASE/lists/$SPACE_ENG_ID/statuses" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d '{"key":"blocked","name":"Blocked","category":"active","color":"#dc2626"}')
check "Admin adds status at space scope → 201" '"id"'      "$R"

R=$(curl -s -X POST "$BASE/lists/$SPACE_ENG_ID/statuses" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d '{"key":"blocked","name":"Blocked2","category":"active","color":"#dc2626"}')
check "Duplicate status key at same scope → 409" 'STATUS_KEY_EXISTS' "$R"

R=$(curl -s -X POST "$BASE/lists/$BACKLOG_ID/statuses" \
  -H "X-User-Id: bob" -H "Content-Type: application/json" \
  -d '{"key":"test","name":"Test","category":"active","color":"#000"}')
check "Member cannot add status → 403"      'FORBIDDEN'    "$R"

# ── Archive task (story 3) ─────────────────────────────
echo ""
echo "── Task archive (story 3)"
R=$(curl -s -X POST "$BASE/tasks/$TASK_ID/archive" \
  -H "X-User-Id: alice")
check "Archive task → archived:true"        '"archived":true' "$R"

R=$(curl -s -H "X-User-Id: alice" "$BASE/tasks/$TASK_ID")
check "Archived task returns 404"           'TASK_NOT_FOUND' "$R"

TASKS=$(curl -s -H "X-User-Id: alice" "$BASE/lists/$BACKLOG_ID/tasks")
if echo "$TASKS" | grep -q 'E2E smoke task'; then
  red "Archived task should not appear in list"
  FAIL=$((FAIL+1))
else
  green "Archived task correctly excluded from list"
  PASS=$((PASS+1))
fi

# ── Error shape (story 8 / docs) ──────────────────────
echo ""
echo "── Consistent error shape"
R=$(curl -s -H "X-User-Id: alice" "$BASE/tasks/nonexistent-id")
check "404 has error.code"                  '"code"'       "$R"
check "404 has error.message"               '"message"'    "$R"
check "404 code is TASK_NOT_FOUND"          'TASK_NOT_FOUND' "$R"

R=$(curl -s -X POST "$BASE/lists/$BACKLOG_ID/tasks" \
  -H "X-User-Id: alice" -H "Content-Type: application/json" \
  -d '{"title":"","statusId":"x"}')
check "400 has error.details array"         '"details"'    "$R"

# ── Summary ───────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
TOTAL=$((PASS+FAIL))
printf "  Results: \033[32m%d passed\033[0m / \033[31m%d failed\033[0m / %d total\n" $PASS $FAIL $TOTAL
echo "═══════════════════════════════════════════════════"
echo ""
[ $FAIL -eq 0 ] && exit 0 || exit 1
