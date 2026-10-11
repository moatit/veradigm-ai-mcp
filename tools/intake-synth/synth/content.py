"""
Nephrology-relevant synthetic results: panels, reference ranges, H/L and critical flags, and the
prose of imaging reports and consult letters. Values are drawn from a per-document "CKD stage" so
a patient's creatinine, eGFR, potassium, phosphorus and PTH move together plausibly.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

# name, units, low, high, decimals, crit_low, crit_high, (normal mean, sd)
ANALYTES: dict[str, tuple] = {
    "Sodium": ("mmol/L", 135, 145, 0, 120, 160, (139, 2.5)),
    "Potassium": ("mmol/L", 3.5, 5.1, 1, 2.8, 6.2, (4.3, 0.35)),
    "Chloride": ("mmol/L", 98, 107, 0, None, None, (102, 2.5)),
    "CO2": ("mmol/L", 22, 29, 0, 12, None, (25, 2)),
    "BUN": ("mg/dL", 7, 20, 0, None, None, (14, 3)),
    "Creatinine": ("mg/dL", 0.60, 1.30, 2, None, None, (0.95, 0.15)),
    "eGFR": ("mL/min/1.73m2", 60, None, 0, None, None, (88, 12)),
    "Glucose": ("mg/dL", 70, 99, 0, 45, 450, (92, 9)),
    "Calcium": ("mg/dL", 8.6, 10.3, 1, 6.5, 13.0, (9.4, 0.35)),
    "Phosphorus": ("mg/dL", 2.5, 4.5, 1, None, None, (3.5, 0.4)),
    "Albumin": ("g/dL", 3.5, 5.0, 1, None, None, (4.2, 0.3)),
    "Total Protein": ("g/dL", 6.0, 8.3, 1, None, None, (7.0, 0.4)),
    "Alkaline Phosphatase": ("U/L", 44, 147, 0, None, None, (85, 20)),
    "AST": ("U/L", 10, 40, 0, None, None, (24, 6)),
    "ALT": ("U/L", 7, 56, 0, None, None, (26, 8)),
    "Bilirubin, Total": ("mg/dL", 0.1, 1.2, 1, None, None, (0.6, 0.2)),
    "PTH, Intact": ("pg/mL", 15, 65, 0, None, None, (42, 10)),
    "Vitamin D, 25-OH": ("ng/mL", 30, 100, 0, None, None, (38, 10)),
    "WBC": ("x10^3/uL", 4.0, 11.0, 1, 1.5, 30.0, (7.0, 1.5)),
    "RBC": ("x10^6/uL", 4.0, 5.6, 2, None, None, (4.6, 0.35)),
    "Hemoglobin": ("g/dL", 12.0, 17.0, 1, 7.0, 20.0, (13.8, 1.0)),
    "Hematocrit": ("%", 36, 50, 1, 21, 60, (41, 3)),
    "MCV": ("fL", 80, 100, 0, None, None, (90, 4)),
    "Platelets": ("x10^3/uL", 150, 400, 0, 50, 1000, (250, 50)),
    "Hemoglobin A1c": ("%", None, 5.6, 1, None, None, (5.4, 0.3)),
    "Cholesterol, Total": ("mg/dL", None, 199, 0, None, None, (180, 25)),
    "LDL Cholesterol": ("mg/dL", None, 99, 0, None, None, (95, 25)),
    "HDL Cholesterol": ("mg/dL", 40, None, 0, None, None, (50, 10)),
    "Triglycerides": ("mg/dL", None, 149, 0, None, None, (130, 40)),
    "Urine Albumin/Creatinine Ratio": ("mg/g", None, 29, 0, None, None, (12, 6)),
    "Urine Creatinine": ("mg/dL", 20, 320, 0, None, None, (110, 40)),
    "Urine Albumin": ("mg/dL", None, 3.0, 1, None, None, (1.2, 0.6)),
}

PANELS: dict[str, list[str]] = {
    "Basic Metabolic Panel": ["Sodium", "Potassium", "Chloride", "CO2", "BUN", "Creatinine", "eGFR", "Glucose", "Calcium"],
    "Comprehensive Metabolic Panel": ["Sodium", "Potassium", "Chloride", "CO2", "BUN", "Creatinine", "eGFR", "Glucose",
                                      "Calcium", "Albumin", "Total Protein", "Alkaline Phosphatase", "AST", "ALT", "Bilirubin, Total"],
    "Renal Function Panel": ["Sodium", "Potassium", "Chloride", "CO2", "BUN", "Creatinine", "eGFR", "Glucose", "Calcium",
                             "Phosphorus", "Albumin"],
    "Parathyroid Hormone": ["PTH, Intact", "Calcium"],
    "Vitamin D": ["Vitamin D, 25-OH"],
    "CBC": ["WBC", "RBC", "Hemoglobin", "Hematocrit", "MCV", "Platelets"],
    "Hemoglobin A1c": ["Hemoglobin A1c"],
    "Lipid Panel": ["Cholesterol, Total", "LDL Cholesterol", "HDL Cholesterol", "Triglycerides"],
    "Urine Albumin/Creatinine Ratio": ["Urine Albumin", "Urine Creatinine", "Urine Albumin/Creatinine Ratio"],
}

UA_FIELDS = [("Color", ["Yellow", "Straw", "Amber"], None), ("Clarity", ["Clear", "Hazy"], "Cloudy"),
             ("Specific Gravity", ["1.010", "1.015", "1.020"], None), ("pH", ["5.5", "6.0", "6.5"], None),
             ("Protein", ["Negative"], "2+"), ("Glucose", ["Negative"], "1+"), ("Blood", ["Negative"], "Moderate"),
             ("Ketones", ["Negative"], None), ("Leukocyte Esterase", ["Negative"], "Small"), ("Nitrite", ["Negative"], None)]


@dataclass
class Result:
    test: str
    value: str
    units: str
    ref: str
    flag: str  # '', 'H', 'L', 'HH', 'LL', 'A'


def _fmt(v: float, dec: int) -> str:
    return f"{v:.{dec}f}"


def _ref(low, high, dec) -> str:
    if low is not None and high is not None:
        return f"{_fmt(low, dec)}-{_fmt(high, dec)}"
    if low is not None:
        return f">={_fmt(low, dec)}" if low != 60 else ">59"
    return f"<{_fmt(high + (1 if dec == 0 else 0.1), dec)}" if high is not None else ""


def ckd_profile(rng: random.Random) -> dict:
    """Stage drives the renal values. 'normal' gives a result set without flags."""
    stage = rng.choices(["normal", "3a", "3b", "4", "5"], weights=[18, 22, 25, 22, 13])[0]
    egfr = {"normal": rng.uniform(65, 105), "3a": rng.uniform(45, 59), "3b": rng.uniform(30, 44),
            "4": rng.uniform(15, 29), "5": rng.uniform(6, 14)}[stage]
    return {"stage": stage, "egfr": egfr, "critical": stage in ("4", "5") and rng.random() < 0.18,
            "diabetic": rng.random() < 0.45}


def value_for(name: str, prof: dict, rng: random.Random) -> float:
    units, low, high, dec, cl, ch, (mu, sd) = ANALYTES[name]
    e = prof["egfr"]
    sev = max(0.0, (60 - e) / 60)  # 0 normal .. ~0.9 stage 5
    if prof["stage"] == "normal":
        v = rng.gauss(mu, sd * 0.6)
        if low is not None:
            v = max(v, low + (high - low) * 0.1 if high is not None else low * 1.05)
        if high is not None:
            v = min(v, high - ((high - low) * 0.1 if low is not None else high * 0.05))
        return v
    if name == "eGFR":
        return e
    if name == "Creatinine":
        return 0.95 * (88 / max(e, 5)) ** 1.05 + rng.gauss(0, 0.05)
    if name == "BUN":
        return 14 + sev * 70 + rng.gauss(0, 4)
    if name == "Potassium":
        if prof["critical"]:
            return rng.uniform(6.3, 7.0)
        return 4.3 + sev * 1.2 + rng.gauss(0, 0.3)
    if name == "Phosphorus":
        return 3.4 + sev * 3.0 + rng.gauss(0, 0.4)
    if name == "PTH, Intact":
        return 45 + sev * 400 + rng.gauss(0, 20)
    if name == "CO2":
        return 25 - sev * 8 + rng.gauss(0, 1.5)
    if name == "Hemoglobin":
        return 13.5 - sev * 4 + rng.gauss(0, 0.6)
    if name == "Hematocrit":
        return 41 - sev * 12 + rng.gauss(0, 1.5)
    if name == "Calcium":
        return 9.3 - sev * 1.2 + rng.gauss(0, 0.3)
    if name == "Albumin":
        return 4.1 - sev * 0.8 + rng.gauss(0, 0.2)
    if name == "Hemoglobin A1c":
        return rng.gauss(7.4, 1.0) if prof["diabetic"] else rng.gauss(5.4, 0.25)
    if name == "Glucose":
        return rng.gauss(150, 40) if prof["diabetic"] else rng.gauss(95, 10)
    if name == "Urine Albumin/Creatinine Ratio":
        return abs(rng.gauss(30 + sev * 900, 120))
    if name == "Urine Albumin":
        return abs(rng.gauss(2 + sev * 60, 8))
    if name == "Vitamin D, 25-OH":
        return rng.gauss(26, 8)
    return rng.gauss(mu, sd)


def make_result(name: str, prof: dict, rng: random.Random) -> Result:
    units, low, high, dec, cl, ch, _ = ANALYTES[name]
    v = value_for(name, prof, rng)
    v = max(v, 0.1 if dec else 1)
    flag = ""
    if cl is not None and v < cl:
        flag = "LL"
    elif ch is not None and v > ch:
        flag = "HH"
    elif low is not None and v < low:
        flag = "L"
    elif high is not None and v > high:
        flag = "H"
    return Result(name, _fmt(v, dec), units, _ref(low, high, dec), flag)


def make_ua(prof: dict, rng: random.Random) -> list[Result]:
    out = []
    abnormal = prof["stage"] in ("3b", "4", "5") and rng.random() < 0.6
    for name, normals, abn in UA_FIELDS:
        if abnormal and abn and rng.random() < 0.5:
            out.append(Result(name, abn, "", normals[0], "A"))
        else:
            out.append(Result(name, rng.choice(normals), "", normals[0] if len(normals) == 1 else "", ""))
    return out


def lab_panels(rng: random.Random, prof: dict, layout: str) -> list[tuple[str, list[Result]]]:
    """Which panels this report carries (2-5)."""
    names = list(PANELS)
    core = rng.choice(["Basic Metabolic Panel", "Comprehensive Metabolic Panel", "Renal Function Panel"])
    extra = rng.sample([n for n in names if n not in ("Basic Metabolic Panel", "Comprehensive Metabolic Panel", "Renal Function Panel")],
                       k=rng.randint(1, 3 if layout != "small_clinic" else 2))
    chosen = [core] + extra
    if layout == "small_clinic":
        chosen = rng.sample(["Hemoglobin A1c", "Lipid Panel", "Urine Albumin/Creatinine Ratio", "Basic Metabolic Panel"], k=2)
    out: list[tuple[str, list[Result]]] = []
    seen: set[str] = set()
    for p in chosen:
        rows = [make_result(a, prof, rng) for a in PANELS[p] if a not in seen]
        seen.update(PANELS[p])
        if rows:
            out.append((p, rows))
    if rng.random() < 0.3:
        out.append(("Urinalysis", make_ua(prof, rng)))
    return out


# ── Imaging and consult prose ────────────────────────────────────────────────

def renal_ultrasound(rng: random.Random, prof: dict) -> tuple[list[tuple[str, str]], bool]:
    """Sections (heading, text) and whether the impression says 'abnormal'."""
    rk = round(rng.uniform(8.6, 12.2), 1)
    lk = round(rng.uniform(8.6, 12.2), 1)
    ckd = prof["stage"] in ("3b", "4", "5")
    findings = [f"Right kidney measures {rk} cm in length. Left kidney measures {lk} cm in length."]
    if ckd:
        findings.append("Both kidneys show increased cortical echogenicity with mild cortical thinning.")
    else:
        findings.append("Normal cortical echogenicity and corticomedullary differentiation bilaterally.")
    cyst = rng.random() < 0.3
    if cyst:
        findings.append(f"Simple cyst in the {rng.choice(['upper', 'lower', 'inter'])}polar {rng.choice(['right', 'left'])} kidney measuring {rng.randint(8, 35)} mm.")
    hydro = rng.random() < 0.12
    findings.append("Mild hydronephrosis on the right." if hydro else "No hydronephrosis. No shadowing calculi.")
    findings.append("The urinary bladder is " + rng.choice(["unremarkable.", "partially distended and unremarkable."]))
    abnormal = ckd or hydro
    if abnormal:
        imp = rng.choice(["Abnormal renal ultrasound. ", "ABNORMAL STUDY. ", ""])
        imp += "Findings consistent with medical renal disease." if ckd else ""
        imp += " Mild right hydronephrosis; correlate clinically." if hydro else ""
        said_abnormal = "bnormal" in imp.split(".")[0] or imp.startswith("ABNORMAL")
    else:
        imp = "No acute abnormality. Kidneys normal in size and echotexture."
        said_abnormal = False
    if cyst:
        imp += " Simple renal cyst, no follow-up needed."
    return ([("CLINICAL HISTORY", f"Chronic kidney disease{' stage ' + prof['stage'] if prof['stage'] != 'normal' else ''}. Evaluate renal size."),
             ("TECHNIQUE", "Real-time grayscale and color Doppler images of both kidneys and the bladder."),
             ("COMPARISON", rng.choice(["None.", "Prior ultrasound from last year."])),
             ("FINDINGS", " ".join(findings)),
             ("IMPRESSION", imp.strip())], said_abnormal)


CONSULTS = [
    ("vascular", "Evaluation for dialysis access",
     ["Vein mapping shows an adequate left cephalic vein of {d} mm at the wrist.",
      "We recommend a left radiocephalic arteriovenous fistula.",
      "Surgery is planned within the next {w} weeks; please hold anticoagulation as discussed."]),
    ("cardiology", "Hypertension and volume management",
     ["Blood pressure today {bp}. Echocardiogram shows preserved ejection fraction.",
      "We increased amlodipine and recommend continued sodium restriction.",
      "We will see the patient again in {w} weeks."]),
    ("endocrinology", "Diabetes management in chronic kidney disease",
     ["Recent hemoglobin A1c reviewed. Insulin doses adjusted for reduced renal clearance.",
      "Continue the SGLT2 inhibitor as tolerated.",
      "Follow up in {w} weeks with a fingerstick log."]),
    ("urology", "Microscopic hematuria",
     ["Cystoscopy was performed and showed no bladder lesion.",
      "CT urogram is scheduled to complete the evaluation.",
      "We will forward the results when available, likely in {w} weeks."]),
    ("transplant", "Kidney transplant candidacy",
     ["The patient attended the transplant education session.",
      "Further workup includes cardiac clearance and dental evaluation.",
      "We will present the case at the selection committee in about {w} weeks."]),
]


def consult_body(rng: random.Random, patient_first: str, patient_last: str, sex: str) -> tuple[str, str, list[str]]:
    spec, reason, lines = rng.choice(CONSULTS)
    title = "Mr." if sex == "M" else "Ms."
    fill = {"d": rng.randint(2, 4), "w": rng.randint(2, 8), "bp": f"{rng.randint(128, 168)}/{rng.randint(72, 96)}"}
    paras = [
        f"Thank you for referring {title} {patient_last} for {reason.lower()}.",
        "History of Present Illness: " + rng.choice([
            "Long-standing hypertension and type 2 diabetes with progressive chronic kidney disease.",
            "Chronic kidney disease followed by your office; referred for further evaluation.",
            "Gradual decline in kidney function over the last two years."]),
        " ".join(s.format(**fill) for s in lines),
        "Assessment and Plan: " + rng.choice(["As above. ", "Discussed with the patient, who agrees with the plan. "])
        + "Please do not hesitate to contact our office with questions.",
    ]
    return spec, reason, paras
