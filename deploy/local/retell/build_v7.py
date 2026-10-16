"""Create (or update) the two v7 A/B test agents in Retell. Never publishes, never touches a phone number
or the live agent (drawbridge-healthcare-agent, agent_972b0d5df0a066741f4fe81cc8).

    python deploy/local/retell/build_v7.py [--dry-run] [realtime|cascade ...]

  drawbridge-v7-realtime   Retell LLM with s2s_model gpt-realtime-2.1 (no `model`), voice openai-Marin
  drawbridge-v7-cascade    Retell LLM with model gpt-4.1 (no Fast Tier), voice 11labs-Grace (as v6)

Both: the trimmed prompt (retell-prompts/unity-healthcare-agent.md), the compact tool list
(src/platform/agent-tools.ts via src/scripts/dump-agent-tools.ts) with a static filler line on lookups,
timeout_ms 8000, max_retry 0; begin_message stating it is the clinic's automated assistant; default
dynamic variables call_mode/records_status UNKNOWN and fhir_tools OFF (the inbound-call webhook or the
web call supplies the real values); backchannel on, no ambient sound, medical vocabulary; PII redaction,
signed URLs, data storage and 30-day retention copied from the live agent.

Agent/LLM IDs are written to deploy/local/retell/v7-agents.json (IDs only). Keys come from
deploy/local/.env and are never printed.
"""
import json, os, subprocess, sys, tempfile, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
ENV = os.path.join(HERE, "..", ".env")
if not os.path.exists(ENV):  # worktrees: the .env lives in the main checkout only
    ENV = r"D:\VeradigmAI-DrawBridge\veradigm-ai-mcp\deploy\local\.env"
API = "https://api.retellai.com"
BASE = "https://drawbridge.moatit.dev"
LIVE_AGENT = "agent_972b0d5df0a066741f4fe81cc8"
LIVE_LLM = "llm_6f0eb9c3edb1f2d62cb7fe5b02fe"
OUT = os.path.join(HERE, "v7-agents.json")

VARIANTS = {
    "realtime": {"agent_name": "drawbridge-v7-realtime", "llm": {"s2s_model": "gpt-realtime-2.1"}, "voice_id": "openai-Marin"},
    "cascade": {"agent_name": "drawbridge-v7-cascade", "llm": {"model": "gpt-4.1", "model_high_priority": False}, "voice_id": "11labs-Grace"},
}
BEGIN = "Hello! You have reached the automated assistant for Idaho Kidney Institute. How can I help you today?"
DEFAULT_VARS = {"call_mode": "UNKNOWN", "records_status": "UNKNOWN", "fhir_tools": "OFF"}
COPY_AGENT = ["language", "data_storage_setting", "data_storage_retention_days", "opt_in_signed_url", "pii_config",
              "post_call_analysis_model", "post_call_analysis_data", "max_call_duration_ms", "end_call_after_silence_ms",
              "interruption_sensitivity", "boosted_keywords", "voice_temperature", "voice_speed", "volume",
              "allow_user_dtmf", "user_dtmf_options", "webhook_url"]


def env():
    return dict(l.split("=", 1) for l in open(ENV, encoding="utf-8").read().splitlines() if "=" in l and not l.startswith("#"))


def call(method, path, body=None, query=None):
    url = API + path + ("?" + "&".join(f"{k}={v}" for k, v in (query or {}).items()) if query else "")
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {env()['RETELL_API_KEY']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {method} {path}: {e.read().decode()[:800]}")


def compact_tools():
    fd, path = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    npx = "npx.cmd" if os.name == "nt" else "npx"
    subprocess.run([npx, "ts-node", "src/scripts/dump-agent-tools.ts", path], cwd=REPO, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    data = json.load(open(path, encoding="utf-8"))
    os.unlink(path)
    return data["retell"]


def retell_tools(live_llm, tool_key):
    tools = [t for t in live_llm["general_tools"] if t.get("type") in ("end_call", "transfer_call")]
    for t in compact_tools():
        c = {
            "type": "custom", "name": t["name"], "description": t["description"],
            "url": f"{BASE}/{t['server']}/api/retell", "method": "POST",
            "headers": {"x-drawbridge-key": tool_key},
            "parameters": t["parameters"],
            "speak_after_execution": True, "timeout_ms": 8000, "max_retry": 0,
            "speak_during_execution": bool(t["filler"]),
        }
        if t["filler"]:
            c["execution_message_type"] = "static_text"
            c["execution_message_description"] = t["filler"]
        tools.append(c)
    return tools


def main(argv):
    dry = "--dry-run" in argv
    names = [a for a in argv if a in VARIANTS] or list(VARIANTS)
    e = env()
    prompt = open(os.path.join(REPO, "retell-prompts", "unity-healthcare-agent.md"), encoding="utf-8").read()
    live_llm = call("GET", f"/get-retell-llm/{LIVE_LLM}")
    live_agent = call("GET", f"/get-agent/{LIVE_AGENT}")
    tools = retell_tools(live_llm, e["DRAWBRIDGE_TOOL_KEY"])
    size = len(prompt) + sum(len(json.dumps({k: t.get(k) for k in ("name", "description", "parameters")})) for t in tools)
    print(f"prompt {len(prompt)} chars, {len(tools)} tools, prompt+tools {size} chars (~{size // 4} tokens)")
    if dry:
        return
    done = json.load(open(OUT)) if os.path.exists(OUT) else {}
    for n in names:
        v = VARIANTS[n]
        llm_body = {"general_prompt": prompt, "general_tools": tools, "begin_message": BEGIN, "start_speaker": "agent",
                    "default_dynamic_variables": DEFAULT_VARS, "tool_call_strict_mode": False, **v["llm"]}
        agent_body = {k: live_agent[k] for k in COPY_AGENT if live_agent.get(k) is not None}
        agent_body.update({"agent_name": v["agent_name"], "voice_id": v["voice_id"], "enable_backchannel": True,
                           "backchannel_frequency": 0.6, "ambient_sound": None, "vocab_specialization": "medical"})
        prev = done.get(n)
        if prev and prev.get("llm_id"):
            call("PATCH", f"/update-retell-llm/{prev['llm_id']}", llm_body)
            llm_id = prev["llm_id"]
            agent_body["response_engine"] = {"type": "retell-llm", "llm_id": llm_id}
            agent = call("PATCH", f"/update-agent/{prev['agent_id']}", agent_body)
            print(n, "updated", prev["agent_id"], llm_id)
        else:
            llm = call("POST", "/create-retell-llm", llm_body)
            llm_id = llm["llm_id"]
            agent_body["response_engine"] = {"type": "retell-llm", "llm_id": llm_id}
            agent = call("POST", "/create-agent", agent_body)
            print(n, "created", agent["agent_id"], llm_id)
        done[n] = {"agent_name": v["agent_name"], "agent_id": agent["agent_id"], "llm_id": llm_id,
                   "agent_version": agent.get("version"), "published": agent.get("is_published", False)}
    json.dump(done, open(OUT, "w"), indent=1)
    print("saved", OUT)


if __name__ == "__main__":
    main(sys.argv[1:])
