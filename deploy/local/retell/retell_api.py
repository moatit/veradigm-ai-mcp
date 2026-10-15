"""Retell admin helper on Retell's current API (no legacy endpoints). Use this instead of ad-hoc curl.

    python retell_api.py versions <agent_id>                  list an agent's versions (GET /list-agent-versions)
    python retell_api.py publish <agent_id> <version> [title]  publish a draft version in place (POST /publish-agent-version)
    python retell_api.py phone-numbers                         which agent/version answers each number (GET /v2/list-phone-numbers)
    python retell_api.py llms                                  Retell LLMs and their models (GET /v2/list-retell-llms)
    python retell_api.py calls [agent_id] [limit]              recent calls, newest first (POST /v3/list-calls)

Retired by Retell (calls may fail at any time): GET /list-*, POST /v2/list-calls, POST /publish-agent,
POST /publish-chat-agent, GET /get-agent-versions, GET /get-chat-agent-versions. List responses are pages:
{ items, has_more, pagination_key }; /v3/list-calls leaves out transcripts and recordings (GET the call for those).
The API key is read from deploy/local/.env (RETELL_API_KEY) and never printed.
"""
import json, os, sys, urllib.parse, urllib.request

ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
API = "https://api.retellai.com"


def _key():
    env = dict(l.split("=", 1) for l in open(ENV, encoding="utf-8").read().splitlines() if "=" in l and not l.startswith("#"))
    return env["RETELL_API_KEY"]


def call(method, path, body=None, query=None):
    url = API + path + ("?" + urllib.parse.urlencode(query) if query else "")
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {_key()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {method} {path}: {e.read().decode()[:500]}")


def pages(method, path, body=None, query=None, limit=1000, max_items=None):
    """Every item of a paginated list (GET: limit/pagination_key in the query; POST: in the body)."""
    out, key = [], None
    while True:
        if method == "GET":
            q = dict(query or {}, limit=limit, **({"pagination_key": key} if key else {}))
            page = call("GET", path, query=q)
        else:
            page = call("POST", path, dict(body or {}, limit=limit, **({"pagination_key": key} if key else {})))
        out += page.get("items", [])
        key = page.get("pagination_key")
        if not page.get("has_more") or not key or (max_items and len(out) >= max_items):
            return out[:max_items] if max_items else out


def versions(agent_id):
    return pages("GET", f"/list-agent-versions/{agent_id}")


def publish(agent_id, version, title=None, description=None):
    body = {"version": int(version)}
    if title:
        body["version_title"] = title
    if description:
        body["version_description"] = description
    return call("POST", f"/publish-agent-version/{agent_id}", body)


def main(argv):
    cmd = argv[0] if argv else ""
    if cmd == "versions":
        for v in versions(argv[1]):
            print(v["version"], "published" if v["is_published"] else "draft", v.get("version_title") or "")
    elif cmd == "publish":
        publish(argv[1], argv[2], argv[3] if len(argv) > 3 else None)
        print("published", argv[1], "version", argv[2])
    elif cmd == "phone-numbers":
        for p in pages("GET", "/v2/list-phone-numbers"):
            agents = [(a.get("agent_id"), a.get("agent_version")) for a in (p.get("inbound_agents") or [])]
            print(p.get("phone_number"), agents)
    elif cmd == "llms":
        for l in pages("GET", "/v2/list-retell-llms"):
            print(l.get("llm_id"), l.get("version"), l.get("model") or l.get("s2s_model"))
    elif cmd == "calls":
        body = {"sort_order": "descending"}
        if len(argv) > 1 and argv[1]:
            body["filter_criteria"] = {"agent": [{"agent_id": argv[1]}]}
        for c in pages("POST", "/v3/list-calls", body, limit=min(int(argv[2]) if len(argv) > 2 else 20, 1000),
                       max_items=int(argv[2]) if len(argv) > 2 else 20):
            print(c.get("call_id"), c.get("agent_id"), c.get("agent_version"), c.get("call_status"), c.get("start_timestamp"), c.get("duration_ms"))
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
