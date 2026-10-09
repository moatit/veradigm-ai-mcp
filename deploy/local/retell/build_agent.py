"""Create drawbridge-healthcare-agent (LLM + agent) in Retell from the running Drawbridge servers.
Does NOT touch unity-healthcare-agent or any phone number."""
import json, sys, urllib.request

ENV = r"D:\VeradigmAI-DrawBridge\veradigm-ai-mcp\deploy\local\.env"
env = dict(l.split("=", 1) for l in open(ENV, encoding="utf-8").read().splitlines() if "=" in l and not l.startswith("#"))
API = "https://api.retellai.com"
KEY = env["RETELL_API_KEY"]
TOOL_KEY = env["DRAWBRIDGE_TOOL_KEY"]
BASE = "https://drawbridge.moatit.dev"


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:800]); sys.exit(1)


UNITY = ["drawbridge_get_call_mode", "drawbridge_save_call_record", "drawbridge_previsit_check",
         "unity_search_patients", "unity_get_patient", "unity_get_patient_appointments", "unity_get_appointment_details",
         "unity_get_open_slots", "unity_get_appointment_types", "unity_save_appointment",
         "unity_get_cancellation_reasons", "unity_cancel_appointment", "unity_confirm_appointment",
         "unity_get_account_balance", "unity_get_insurance_policy", "unity_create_staff_task",
         "unity_get_patient_allergies", "unity_get_patient_problems", "unity_get_patient_medications",
         "unity_get_location_hours"]
FHIR = ["verify_patient_identity", "get_patient_medications", "get_allergies", "check_refill_status",
        "get_patient_conditions", "get_recent_observations"]

defs = {}
for fname, server in [("unity-tools.json", "unity"), ("fhir-tools.json", "fhir")]:
    for t in json.load(open(fname))["tools"]:
        defs[t["name"]] = (server, t)


def custom(name):
    server, t = defs[name]
    schema = dict(t.get("inputSchema") or {"type": "object", "properties": {}})
    schema.setdefault("properties", {})
    return {
        "type": "custom", "name": name, "description": (t.get("description") or name)[:1000],
        "url": f"{BASE}/{server}/api/retell", "method": "POST",
        "headers": {"x-drawbridge-key": TOOL_KEY},
        "parameters": {"type": "object", "properties": schema["properties"], "required": schema.get("required", [])},
        "speak_during_execution": False, "speak_after_execution": True, "timeout_ms": 20000,
    }


missing = [n for n in UNITY + FHIR if n not in defs]
if missing:
    print("missing tools:", missing); sys.exit(1)

old = json.load(open("llm36.json"))
prompt = open(r"D:\VeradigmAI-DrawBridge\veradigm-ai-mcp\retell-prompts\unity-healthcare-agent.md", encoding="utf-8").read()
tools = [{"type": "end_call", "name": "end_call", "description": "End the call when the caller is done or asks to hang up."}]
tools += [custom(n) for n in UNITY + FHIR]

llm = call("POST", "/create-retell-llm", {
    "model": old.get("model", "gpt-4.1"),
    "start_speaker": "agent",
    "begin_message": old.get("begin_message"),
    "general_prompt": prompt,
    "general_tools": tools,
    "tool_call_strict_mode": False,
})
print("llm", llm["llm_id"])

a = json.load(open("agent.json"))
keep = ["voice_id", "voice_speed", "voice_temperature", "volume", "language", "interruption_sensitivity",
        "ambient_sound", "end_call_after_silence_ms", "max_call_duration_ms", "allow_user_dtmf", "user_dtmf_options",
        "data_storage_setting", "pii_config", "post_call_analysis_data", "post_call_analysis_model", "opt_in_signed_url"]
body = {k: a[k] for k in keep if a.get(k) is not None}
body.update({"agent_name": "drawbridge-healthcare-agent", "response_engine": {"type": "retell-llm", "llm_id": llm["llm_id"]}})
agent = call("POST", "/create-agent", body)
print("agent", agent["agent_id"], "tools", len(tools))
json.dump({"llm_id": llm["llm_id"], "agent_id": agent["agent_id"]}, open("created.json", "w"))
