#!/usr/bin/env bash
# End-to-end smoke test against a running instance.
#   BASE=http://127.0.0.1:8899 ./scripts/smoke.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8899}"
TS_HOST="${TS_HOST:-https://embed-1-do-not-delete.thoughtspotdev.cloud}"
LB_ID="${LB_ID:-d084c256-e284-4fc4-b80c-111cb606449a}"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
check() {
  if [ "$1" = "$2" ]; then
    printf '  ok   %s (%s)\n' "$3" "$1"
  else
    printf '  FAIL %s: expected %s got %s\n' "$3" "$2" "$1"
    exit 1
  fi
}

say "1. create project"
CREATE=$(curl -sS -X POST "$BASE/api/projects" \
  -H 'content-type: application/json' \
  --data @- <<JSON
{
  "name": "Acme demo",
  "thoughtSpotHost": "$TS_HOST",
  "sdkVersion": "1.51.0",
  "theme": { "colorPrimary": "#7b3fe4", "radius": "12px" },
  "header": {
    "title": "Acme Analytics",
    "sticky": true,
    "nav": [
      { "label": "Home", "to": "/" },
      { "label": "Sales", "to": "/sales" },
      { "label": "Q3", "to": "/sales/q3" }
    ]
  },
  "footer": { "text": "Acme demo — embed-sandbox" }
}
JSON
)
echo "$CREATE"
PID=$(echo "$CREATE" | sed -n 's/.*"projectId":"\([^"]*\)".*/\1/p')
TOKEN=$(echo "$CREATE" | sed -n 's/.*"editToken":"\([^"]*\)".*/\1/p')
[ -n "$PID" ] || { echo "no projectId returned"; exit 1; }
printf '  project=%s\n' "$PID"

say "2. write nested pages over the API"
for SPEC in "/:Home:false" "/sales:Sales:true" "/sales/q3:Q3 detail:true"; do
  PATH_=${SPEC%%:*}; REST=${SPEC#*:}; TITLE=${REST%%:*}; PRE=${REST##*:}
  # preRender requires an id now; one per page keeps them distinct.
  PRE_ID=$(printf '%s' "$PATH_" | tr -c 'a-z0-9' '-')
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/projects/$PID/pages" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    --data @- <<JSON
{
  "path": "$PATH_",
  "page": {
    "title": "$TITLE",
    "blocks": [
      { "type": "heading", "text": "$TITLE", "level": 1 },
      { "type": "text", "text": "Rendered from JSON by the sandbox runtime." },
      { "type": "buttons", "items": [
        { "label": "Reload", "action": "reload", "variant": "primary" },
        { "label": "West only", "action": "set-filter", "column": "Region", "values": ["West"] },
        { "label": "Reset view", "action": "host-event", "hostEvent": "ResetLiveboardPersonalisedView" }
      ]},
      { "type": "embed", "embed": {
        "type": "liveboard",
        "liveboardId": "$LB_ID",
        "fullHeight": true,
        "preRender": $PRE,
        "preRenderId": "smoke$PRE_ID",
        "hiddenActions": ["download"]
      }}
    ]
  }
}
JSON
  )
  check "$CODE" "200" "PUT $PATH_"
done

say "3. auth is enforced"
check "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/projects/$PID/pages" \
  -H 'content-type: application/json' -d '{"path":"/nope","page":{}}')" "401" "PUT without token"
check "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/projects/$PID/pages" \
  -H 'authorization: Bearer deadbeef' -H 'content-type: application/json' \
  -d '{"path":"/nope","page":{}}')" "401" "PUT with wrong token"

say "4. validation rejects junk"
check "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/projects/$PID/pages" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"/bad","page":{"blocks":[{"type":"embed","embed":{"type":"not-a-type"}}]}}')" \
  "400" "unknown embed type"
check "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/projects/$PID/pages" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"/../escape","page":{}}')" "400" "path traversal"

say "5. shell renders for every nested path"
for P in "/" "/sales" "/sales/q3"; do
  check "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/p/$PID$P")" "200" "GET /p/\$PID$P"
done
SHELL_HTML=$(curl -sS "$BASE/p/$PID/sales/q3")
echo "$SHELL_HTML" | grep -q 'id="sb-manifest"' && echo "  ok   manifest inlined"
echo "$SHELL_HTML" | grep -q 'visual-embed-sdk@1.51.0' && echo "  ok   SDK version pinned in preload"
echo "$SHELL_HTML" | grep -q -- '--sb-primary:#7b3fe4' && echo "  ok   theme vars inlined"
echo "$SHELL_HTML" | grep -q 'rel="preconnect" href="https://cdn.jsdelivr.net"' && echo "  ok   CDN preconnect"
printf '  shell size: %s bytes\n' "$(printf '%s' "$SHELL_HTML" | wc -c | tr -d ' ')"

say "6. MCP handshake + tools"
MCP="$BASE/mcp/$PID"
INIT=$(curl -sS -X POST "$MCP" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
echo "$INIT" | grep -q 'embed-sandbox' && echo "  ok   initialize"
TOOLS=$(curl -sS -X POST "$MCP" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
for T in get_site set_site list_pages get_page set_page delete_page get_config save_config connect_cluster list_metadata; do
  echo "$TOOLS" | grep -q "\"$T\"" && printf '  ok   tool %s\n' "$T"
done

say "7. MCP can edit a page (agent path)"
curl -sS -X POST "$MCP" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data @- >/dev/null <<'JSON'
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_page","arguments":{
  "path":"/mcp-made",
  "page":{"title":"Made by an agent","blocks":[
    {"type":"heading","text":"Made by an agent","level":1},
    {"type":"buttons","items":[{"label":"Home","action":"nav","to":"/"}]}
  ]}
}}}
JSON
LIST=$(curl -sS -X POST "$MCP" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_pages","arguments":{}}}')
echo "$LIST" | grep -q '/mcp-made' && echo "  ok   set_page via MCP landed"
# tools/call returns the payload as JSON *inside* a JSON string, so quotes arrive escaped.
echo "$LIST" | grep -q 'preRender[^,]*true' && echo "  ok   list_pages reports preRender"

say "8. MCP rejects a bad token"
check "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$MCP" \
  -H 'authorization: Bearer nope' -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/list"}')" "401" "MCP wrong token"

say "9. cache invalidates after a write"
BEFORE=$(curl -sS "$BASE/p/$PID/" | grep -c 'mcp-made' || true)
curl -sS -X PUT "$BASE/api/projects/$PID/pages" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"path":"/cache-probe","page":{"title":"Cache probe","blocks":[{"type":"text","text":"probe"}]}}' >/dev/null
AFTER=$(curl -sS "$BASE/p/$PID/" | grep -c 'cache-probe' || true)
check "$AFTER" "1" "new page visible in shell after write (was $BEFORE)"

printf '\n\033[1mall checks passed\033[0m\n'
printf 'site : %s/p/%s/\n' "$BASE" "$PID"
printf 'mcp  : %s/mcp/%s\n' "$BASE" "$PID"
printf 'token: %s\n' "$TOKEN"
