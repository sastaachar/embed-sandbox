#!/usr/bin/env bash
# Seed a demo project with a nested page structure.
#   BASE=http://127.0.0.1:8899 TS_HOST=https://your.thoughtspot.cloud \
#   LB_ID=<guid> WS_ID=<guid> ./scripts/demo.sh
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8899}"
TS_HOST="${TS_HOST:-}"
LB_ID="${LB_ID:-REPLACE_LIVEBOARD_GUID}"
WS_ID="${WS_ID:-REPLACE_WORKSHEET_GUID}"

HOST_FIELD=""
[ -n "$TS_HOST" ] && HOST_FIELD="\"thoughtSpotHost\": \"$TS_HOST\","

CREATE=$(curl -sS -X POST "$BASE/api/projects" -H 'content-type: application/json' --data @- <<JSON
{
  "name": "Embed showcase",
  $HOST_FIELD
  "sdkVersion": "1.51.0",
  "authType": "None",
  "theme": {
    "colorPrimary": "#2f6fed",
    "colorSurface": "#f4f6fa",
    "radius": "10px",
    "maxWidth": "1280px",
    "space": "22px"
  },
  "header": {
    "title": "Embed showcase",
    "subtitle": "one Worker, JSON pages, agent-editable",
    "sticky": true,
    "align": "split",
    "nav": [
      { "label": "Overview", "to": "/" },
      { "label": "Sales", "to": "/sales" },
      { "label": "Q3 detail", "to": "/sales/q3" },
      { "label": "Search", "to": "/search" }
    ]
  },
  "footer": { "text": "embed-sandbox demo", "links": [{ "label": "Repo", "url": "https://github.com" }] }
}
JSON
)
PID=$(echo "$CREATE" | sed -n 's/.*"projectId":"\([^"]*\)".*/\1/p')
TOKEN=$(echo "$CREATE" | sed -n 's/.*"editToken":"\([^"]*\)".*/\1/p')
[ -n "$PID" ] || { echo "create failed: $CREATE"; exit 1; }

put() { # put <path> <json-page>
  curl -sS -o /dev/null -X PUT "$BASE/api/projects/$PID/pages" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    --data @- <<JSON
{ "path": "$1", "page": $2 }
JSON
}

put "/" '{
  "title": "Overview",
  "blocks": [
    { "type": "heading", "text": "Embed showcase", "level": 1 },
    { "type": "text", "text": "Every page here is JSON. An AI agent connected over MCP writes these pages; what you are looking at is the rendered result, not an editor." },
    { "type": "buttons", "items": [
      { "label": "Sales liveboard", "action": "nav", "to": "/sales", "variant": "primary" },
      { "label": "Q3 detail", "action": "nav", "to": "/sales/q3" },
      { "label": "Search", "action": "nav", "to": "/search" }
    ]},
    { "type": "divider" },
    { "type": "text", "text": "The Sales and Q3 pages pre-render on this first load, so navigating to them is instant." }
  ]
}'

put "/sales" "{
  \"title\": \"Sales\",
  \"blocks\": [
    { \"type\": \"heading\", \"text\": \"Sales\", \"level\": 1 },
    { \"type\": \"buttons\", \"items\": [
      { \"label\": \"Reload\", \"action\": \"reload\", \"variant\": \"primary\" },
      { \"label\": \"West only\", \"action\": \"set-filter\", \"column\": \"Region\", \"values\": [\"West\"] },
      { \"label\": \"Reset view\", \"action\": \"host-event\", \"hostEvent\": \"ResetLiveboardPersonalisedView\" },
      { \"label\": \"Q3 detail\", \"action\": \"nav\", \"to\": \"/sales/q3\" }
    ]},
    { \"type\": \"embed\", \"embed\": {
      \"type\": \"liveboard\",
      \"liveboardId\": \"$LB_ID\",
      \"fullHeight\": true,
      \"preRender\": true
    }}
  ]
}"

put "/sales/q3" "{
  \"title\": \"Q3 detail\",
  \"header\": { \"subtitle\": \"nested page, its own embed config\" },
  \"blocks\": [
    { \"type\": \"heading\", \"text\": \"Q3 detail\", \"level\": 1 },
    { \"type\": \"text\", \"text\": \"Same liveboard, different config: fixed frame height, download hidden.\" },
    { \"type\": \"buttons\", \"items\": [
      { \"label\": \"Reload\", \"action\": \"reload\" },
      { \"label\": \"Pin\", \"action\": \"host-event\", \"hostEvent\": \"Pin\" },
      { \"label\": \"Back to Sales\", \"action\": \"nav\", \"to\": \"/sales\" }
    ]},
    { \"type\": \"embed\", \"embed\": {
      \"type\": \"liveboard\",
      \"liveboardId\": \"$LB_ID\",
      \"preRender\": true,
      \"hiddenActions\": [\"download\"],
      \"frameParams\": { \"height\": 720 }
    }}
  ]
}"

put "/search" "{
  \"title\": \"Search\",
  \"blocks\": [
    { \"type\": \"heading\", \"text\": \"Search\", \"level\": 1 },
    { \"type\": \"text\", \"text\": \"A different embed type on the same site. Not pre-rendered — built on arrival.\" },
    { \"type\": \"embed\", \"embed\": {
      \"type\": \"search\",
      \"dataSource\": \"$WS_ID\",
      \"fullHeight\": true
    }}
  ]
}"

printf '\nproject : %s\n' "$PID"
printf 'site    : %s/p/%s/\n' "$BASE" "$PID"
printf 'mcp     : %s/mcp/%s\n' "$BASE" "$PID"
printf 'token   : %s\n' "$TOKEN"
if [ -z "$TS_HOST" ]; then
  printf '\nNo TS_HOST set, so embed blocks will show a "set thoughtSpotHost" note.\nSet it with:\n'
  printf "  curl -X PATCH %s/api/projects/%s -H 'authorization: Bearer %s' \\\\\n" "$BASE" "$PID" "$TOKEN"
  printf "    -H 'content-type: application/json' -d '{\"thoughtSpotHost\":\"https://your.thoughtspot.cloud\"}'\n"
fi
printf '\nconnect an agent:\n'
printf '  claude mcp add --transport http embed-sandbox %s/mcp/%s \\\n' "$BASE" "$PID"
printf '    --header "Authorization: Bearer %s"\n' "$TOKEN"
