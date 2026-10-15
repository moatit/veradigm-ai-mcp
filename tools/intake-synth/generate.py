"""
Synthetic fax / lab document generator for the Drawbridge intake test bench.

  python generate.py generate --roster 300 --docs 1000 --seed 42 --out /out/set-s42 [--workers 8]

Writes (all invented data; the output directory must be git-ignored):
  roster.json          patients the fake Veradigm search knows (both MRNs, phones, hard-case tags)
  outside.json         people who are NOT in the roster
  manifest.json        seed, counts, the generation date
  docs/<id>.pdf|.tif   the documents: text-layer PDFs (emailed), fax TIFFs (G4/G3), image-only PDFs
  truth/<id>.json      ground truth: intended patient, expected match decision, printed fields, kind,
                       sender, collection date, abnormal flags, layout, quality; and per page: which
                       patient's content is on it, whether that patient's identifiers are readable
                       (or blotted out), and the expected outcome (filed to whom, or staff review)

Multi-patient files: "multi_patient" daily batches hold 2-6 patients, one or more pages each, in
three styles (a new page per patient with the patient line repeated on continuation pages, the
same without the repeat, or packed several to a page); some fax copies have one page's or one
patient's identifier lines blotted out. "multi_report" faxes carry two single-patient reports.

Third identifier: patients have addresses and SSN last 4 (invented); some layouts print them, current,
outdated or wrong (see plan_third). "namesake" documents are about someone outside the roster with exactly
a roster patient's name and DOB; they print their own address or SSN last 4 and must never be filed.

Deterministic: the same seed and arguments give the same documents byte for byte (each document
has its own RNG seeded from "<seed>:<index>", so worker count does not matter).
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from dataclasses import asdict
from datetime import date, datetime, timedelta
from multiprocessing import Pool

import numpy as np

from synth.content import ckd_profile
from synth.fax import fax_pages, save_image_pdf, save_tiff
from synth.layouts import SENDERS, DocSpec, Printed, render
from synth.roster import DIRS, SUFFIXES, Patient, add_third_ids, build_roster, street_line

GENERATED = datetime(2026, 10, 11, 8, 0)

LAYOUT_WEIGHTS = {"reference_lab": 22, "hospital_lab": 17, "small_clinic": 14, "daily_batch": 15, "imaging": 16, "consult": 16}
CASE_WEIGHTS = {
    "normal": 50, "no_mrn": 11, "wrong_mrn": 6, "not_in_roster": 8, "duplicate": 4, "same_name_diff_dob": 4,
    "soundalike": 4, "hyphen_apostrophe": 4, "multiword": 1.5, "twin": 2, "household": 2, "old_phone": 1.5,
    "dob_typo": 1.5, "multi_patient": 8, "multi_report": 2, "namesake": 1.5,
}
BATCH_STYLE_MULTI = {"per_page": 65, "no_repeat": 15, "packed": 20}
BATCH_STYLE_SINGLE = {"per_page": 85, "no_repeat": 15}
REPORT_LAYOUTS = ["reference_lab", "hospital_lab", "small_clinic", "imaging"]
QUALITY_WEIGHTS = {"text_pdf": 20, "fine": 35, "standard": 33, "poor": 12}
CONTAINER_WEIGHTS = {"tiff_g4": 50, "tiff_g3": 20, "image_pdf": 30}

MRN_P = {"reference_lab": 0.85, "hospital_lab": 1.0, "small_clinic": 0.3, "daily_batch": 0.9, "imaging": 0.6, "consult": 0.3}
MRN_LABELS = {
    "reference_lab": ["Patient ID:", "MRN:", "Client MRN:", "Chart #:"],
    "hospital_lab": ["MRN:"],
    "small_clinic": ["Ref MRN:", "Chart #:"],
    "daily_batch": ["MRN:", "PATIENT ID:"],
    "imaging": ["MRN:", "Med Rec #:"],
    "consult": ["MRN:", "Chart No.:"],
}
PHONE_P = {"reference_lab": 0.4, "hospital_lab": 0.3, "small_clinic": 0.6, "daily_batch": 0.3, "imaging": 0.2, "consult": 0.1}
PHONE_LABELS = {
    "reference_lab": ["Patient Phone:", "Home Phone:"],
    "hospital_lab": ["Home Phone:", "Cell Phone:"],
    "small_clinic": ["Phone:"],
    "daily_batch": ["PT PHONE:"],
    "imaging": ["Patient Phone:"],
    "consult": ["Phone:"],
}
NAME_STYLES = {
    "reference_lab": ["LAST, FIRST M", "Last, First"],
    "hospital_lab": ["First M. Last", "First Last", "FIRST LAST"],
    "small_clinic": ["Last, First", "First Last"],
    "daily_batch": ["LAST,FIRST"],
    "imaging": ["LAST, FIRST M", "First Last", "Last, First"],
    "consult": ["First M. Last", "First Last"],
}
DOB_STYLES = {
    "reference_lab": ["mdy", "mdy_short"],
    "hospital_lab": ["mdy", "dmy"],
    "small_clinic": ["mdy", "mdy_short", "mdyy"],
    "daily_batch": ["iso", "mdy"],
    "imaging": ["mdy", "iso", "mon"],
    "consult": ["month", "mdy", "mon"],
}


# Third identifier (SSN last 4, patient address): how often each layout prints them.
ADDR_P = {"reference_lab": 0.35, "hospital_lab": 0.45, "small_clinic": 0.35, "daily_batch": 0.15, "imaging": 0.25, "consult": 0.5}
SSN_P = {"reference_lab": 0.25, "hospital_lab": 0.3, "small_clinic": 0.15, "daily_batch": 0.15, "imaging": 0.1, "consult": 0.1}
ADDR_LABELS = {
    "reference_lab": ["Address:", "Patient Address:"], "hospital_lab": ["Address:", "Home Address:"],
    "small_clinic": ["Address:"], "daily_batch": ["ADDR:"], "imaging": ["Address:", "Patient Address:"],
    "consult": ["", "", "Address:"],  # letters often print the address under the patient line, unlabelled
}
NAMESAKE_LAYOUTS = ["reference_lab", "hospital_lab", "small_clinic", "imaging", "consult"]


def pick(rng: random.Random, weights: dict) -> str:
    return rng.choices(list(weights), weights=list(weights.values()))[0]


def dob_date(s: str) -> date:
    m, d, y = (int(x) for x in s.split("/"))
    return date(y, m, d)


def mmddyyyy(d: date) -> str:
    return d.strftime("%m/%d/%Y")


# ── Expected decision (the ideal rule set applied to what is printed) ────────

def norm(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower())


def norm_mrn(s: str) -> str:
    v = re.sub(r"[^A-Z0-9]", "", str(s).upper())
    return re.sub(r"^0+(?=.)", "", v)


def first_agrees(a: str, b: str) -> bool:
    if a == b:
        return True
    s, l = (a, b) if len(a) < len(b) else (b, a)
    return len(s) >= 3 and l.startswith(s)


def expected_decision(p: Printed, roster: list[Patient]) -> tuple[str, str | None]:
    """(decision, roster key of the single name+DOB hit or None)."""
    dob = mmddyyyy(p.dob)
    hits = [r for r in roster if norm(r.last) == norm(p.last) and r.dob == dob and first_agrees(norm(r.first), norm(p.first))]
    if not hits:
        return "none", None
    if len(hits) > 1:
        return "ambiguous", None
    c = hits[0]
    if p.mrn and norm_mrn(p.mrn) not in {norm_mrn(c.pm_mrn), norm_mrn(c.ehr_mrn)}:
        return "review", c.key
    agree, conflict = third_status(p, c)
    if conflict:  # an SSN last 4 or address that disagrees: staff, whatever else agrees
        return "review", c.key
    if p.mrn:
        return "auto", c.key
    exact = norm(c.first) == norm(p.first) and norm(c.last) == norm(p.last)
    if p.phone:
        if exact and p.phone in {c.home_phone, c.cell_phone}:
            return "auto", c.key
        if p.phone not in {c.home_phone, c.cell_phone}:
            return "review", c.key
    if exact and agree:  # SSN last 4 or address as the second identifier, like the phone
        return "auto", c.key
    return "review", c.key


def _street_key(s: dict) -> tuple:
    suffix = SUFFIXES[s["suffix"]][0].lower() if "suffix" in s else ""
    direction = DIRS[s["dir"]][0].lower() if s.get("dir", -1) >= 0 else ""
    return s.get("number", ""), s.get("name", "").lower(), suffix, direction


def third_status(p: Printed, c: Patient) -> tuple:
    """
    Mirror of checkThird() in match.ts on what is printed: (agreeing third identifiers, any conflict).
    SSN last 4: equal digits agree; none on file is unchecked. Address: street number + ZIP, or street
    number + street name (a missing suffix or directional is allowed).
    """
    t = p.third or {}
    agree = []
    conflict = False
    if t.get("ssn4") and c.ssn4:
        if t["ssn4"] == c.ssn4:
            agree.append("ssn4")
        else:
            conflict = True
    a = t.get("address")
    if a and c.street:
        dn, dname, dsuf, ddir = _street_key(a)
        cn, cname, csuf, cdir = _street_key(c.street)
        same_name = dname == cname and (not dsuf or not csuf or dsuf == csuf) and (not ddir or not cdir or ddir == cdir)
        if dn == cn and (a.get("zip") == c.zip or same_name):
            agree.append("address")
        else:
            conflict = True
    return agree, conflict


# Labels the extractor reads as an explicit patient-name label ('high'); "RE:" and "Name:" are weaker.
STRONG_NAME_LABELS = {"Patient Name:", "Patient:", "PT:"}


def soundex(s: str) -> str:
    w = norm(s)
    if not w:
        return ""
    code = {**dict.fromkeys("bfpv", "1"), **dict.fromkeys("cgjkqsxz", "2"), **dict.fromkeys("dt", "3"), "l": "4",
            **dict.fromkeys("mn", "5"), "r": "6"}
    out, prev = w[0].upper(), code.get(w[0], "")
    for ch in w[1:]:
        c = code.get(ch, "")
        if c and c != prev:
            out += c
        if ch not in "hw":
            prev = c
    return (out + "000")[:4]


def one_edit(a: str, b: str) -> bool:
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    i = 0
    while i < len(a) and i < len(b) and a[i] == b[i]:
        i += 1
    return a[i + 1:] == b[i + 1:] or a[i:] == b[i + 1:] or a[i + 1:] == b[i:]


def similar_names(af: str, al: str, bf: str, bl: str) -> bool:
    """Mirror of similarNames() in src/platform/modules/intake/match.ts."""
    af, al, bf, bl = norm(af), norm(al), norm(bf), norm(bl)
    if not al or not bl:
        return False
    if al == bl:
        return True
    if one_edit(af + al, bf + bl) or (af == bl and al == bf):
        return True
    last_sim = one_edit(al, bl) or soundex(al) == soundex(bl)
    first_sim = af == bf or one_edit(af, bf) or soundex(af) == soundex(bf) or first_agrees(af, bf)
    return last_sim and first_sim


def near_dob(a: str, b: str) -> bool:
    """Mirror of nearDob() in match.ts: MM/DD/YYYY one character apart, or day and month swapped."""
    if a == b:
        return False
    if len(a) == len(b) and sum(x != y for x, y in zip(a, b)) == 1:
        return True
    am, ad, ay = a.split("/")
    bm, bd, by = b.split("/")
    return ay == by and am == bd and ad == bm


def expected_decision_name_dob(p: Printed, roster: list[Patient], name_label: str) -> tuple[str, str | None]:
    """
    The optional INTAKE_MATCH_RULE=name_dob applied to what is printed: the default rule, plus 'auto'
    for an exact full name + DOB under an explicit patient label when no MRN or phone is printed, one
    patient has that exact name + DOB, and no other patient with a similar name has that DOB or one a
    character off (or with day and month swapped).
    """
    d, hit = expected_decision(p, roster)
    if d != "review" or hit is None or p.mrn or p.phone or name_label not in STRONG_NAME_LABELS:
        return d, hit
    c = next(r for r in roster if r.key == hit)
    if third_status(p, c)[1]:  # a disagreeing SSN last 4 or address: staff under every rule
        return d, hit
    t = p.third or {}
    if (t.get("ssn4") and not c.ssn4) or (t.get("address") and not c.street):
        return d, hit  # printed but nothing on file to compare with: may be a namesake, staff
    if norm(c.first) != norm(p.first) or norm(c.last) != norm(p.last):
        return d, hit
    dob = mmddyyyy(p.dob)
    exact = [r for r in roster if norm(r.first) == norm(p.first) and norm(r.last) == norm(p.last) and r.dob == dob]
    if len(exact) != 1:
        return d, hit
    if any(r.key != c.key and (r.dob == dob or near_dob(r.dob, dob)) and similar_names(p.first, p.last, r.first, r.last) for r in roster):
        return d, hit
    return "auto", hit


# ── Planning one document ────────────────────────────────────────────────────

def plan_third(seed: int, i: int, layout: str, case: str, pts: list, printed: list) -> None:
    """
    Whether and how each patient's SSN last 4 and address are printed: current address (in varied
    spellings), an outdated one (the patient moved) or a wrong one (another house number), and the right
    SSN last 4 or a wrong one, masked, last 4 only or a full fictional SSN. Own RNG: the rest of the
    document is the same as without third identifiers. Namesake documents always carry at least one.
    """
    trng = random.Random(f"{seed}:{i}:third")
    for pt, pr in zip(pts, printed):
        force = case == "namesake"
        show_addr = trng.random() < ADDR_P[layout]
        show_ssn = trng.random() < SSN_P[layout]
        if force and not (show_addr or show_ssn):
            show_addr, show_ssn = (True, False) if trng.random() < 0.5 else (False, True)
        if show_addr and pt.street:
            kind, street, city, zip_ = "current", pt.street, pt.city, pt.zip
            r = trng.random()
            if not force and r < 0.14 and pt.old_street:
                kind, street, city, zip_ = "outdated", pt.old_street, pt.old_city, pt.old_zip
            elif not force and 0.14 <= r < 0.22:
                kind, street = "wrong", dict(pt.street)
                while street["number"] == pt.street["number"]:
                    street["number"] = str(trng.randint(100, 19999))
            upper = layout == "daily_batch" or trng.random() < 0.15
            line = street_line(street, spelled=trng.random() < 0.3, upper=upper, unit_style="#" if trng.random() < 0.3 else "Apt")
            state = "OR" if zip_.startswith("97") else "ID"
            csz = f"{city}, {state} {zip_}"
            csz = csz.upper() if upper else csz
            pr.address_lines = [f"{line}, {csz}"] if layout == "daily_batch" or trng.random() < 0.5 else [line, csz]
            pr.address_label = trng.choice(ADDR_LABELS[layout])
            pr.third["address"] = {**street, "zip": zip_}
            pr.third["address_kind"] = kind
        if show_ssn:
            kind, last4 = ("right", pt.ssn4) if pt.ssn4 else ("not_on_file", f"{trng.randint(1, 9999):04d}")
            if not force and pt.ssn4 and trng.random() < 0.10:
                kind = "wrong"
                while last4 == pt.ssn4:
                    last4 = f"{trng.randint(1, 9999):04d}"
            style = trng.choices(["masked", "xxx", "last4", "full"], weights=[35, 25, 20, 20])[0]
            # Full SSNs use area numbers 900-999, which are never issued: fictional by construction.
            pr.ssn_text = {"masked": f"***-**-{last4}", "xxx": f"XXX-XX-{last4}", "last4": last4,
                           "full": f"{trng.randint(900, 999)}-{trng.randint(10, 99)}-{last4}"}[style]
            if style == "last4":
                pr.ssn_label = "SSN Last 4:"
            elif layout == "daily_batch":
                pr.ssn_label = trng.choice(["SSN:", "SS#:"])
            else:
                pr.ssn_label = trng.choice(["SSN:", "SSN:", "Soc Sec #:"])
            pr.third.update({"ssn4": last4, "ssn_kind": kind, "ssn_style": style})


def sender_numbers() -> None:
    """Give every sender a fixed fictional phone and fax: 208-555-0150 and up (patients use other areas)."""
    n = 150
    for lay in SENDERS:
        for s in SENDERS[lay]:
            s.setdefault("phone", f"208555{n:04d}")
            s.setdefault("fax", f"208555{n + 1:04d}")
            n += 2


def plan_doc(i: int, seed: int, roster: list[Patient], outside: list[Patient]) -> dict:
    rng = random.Random(f"{seed}:{i}")
    layout = pick(rng, LAYOUT_WEIGHTS)
    case = pick(rng, CASE_WEIGHTS)
    if case == "multi_patient":
        layout = "daily_batch"
    elif case == "multi_report":
        layout = rng.choice(REPORT_LAYOUTS)
    by_tag: dict[str, list[Patient]] = {}
    for p in roster:
        for t in p.tags or ["plain"]:
            by_tag.setdefault(t, []).append(p)
    tag_for_case = {"duplicate": "duplicate", "same_name_diff_dob": "same_name_diff_dob", "soundalike": "soundalike",
                    "multiword": "multiword", "twin": "twin", "household": "household"}
    if case in tag_for_case:
        pts = [rng.choice(by_tag[tag_for_case[case]])]
    elif case == "hyphen_apostrophe":
        pts = [rng.choice(by_tag.get("hyphen", []) + by_tag.get("apostrophe", []))]
    elif case == "not_in_roster":
        pts = [rng.choice([p for p in outside if "namesake" not in p.tags])]
    elif case == "namesake":
        # Not our patient, but exactly the name and DOB of one; the document carries their own address or SSN.
        layout = layout if layout in NAMESAKE_LAYOUTS else rng.choice(NAMESAKE_LAYOUTS)
        pts = [rng.choice([p for p in outside if "namesake" in p.tags])]
    elif case == "multi_patient":
        pts = rng.sample([p for p in roster if "duplicate" not in p.tags], k=rng.randint(2, 6))
    elif case == "multi_report":
        pts = rng.sample([p for p in roster if "duplicate" not in p.tags], k=2)
    else:
        pts = [rng.choice([p for p in roster if "duplicate" not in p.tags])]

    printed: list[Printed] = []
    for k, pt in enumerate(pts):
        mrn = None
        mrn_kind = None
        if rng.random() < MRN_P[layout] or case == "wrong_mrn":
            mrn_kind = rng.choice(["pm", "ehr"])
            mrn = pt.pm_mrn if mrn_kind == "pm" else pt.ehr_mrn
            if layout == "hospital_lab" and rng.random() < 0.4:
                mrn_kind, mrn = "foreign", f"H{rng.randint(1000000, 9999999)}"
            elif layout == "consult" and rng.random() < 0.3:
                mrn_kind, mrn = "foreign", str(rng.randint(1000, 99999))
            if mrn_kind in ("pm", "ehr") and rng.random() < 0.15:
                mrn = mrn.zfill(8)
        if case == "wrong_mrn":
            other = rng.choice([p for p in roster if p.key != pt.key])
            mrn_kind = "wrong_other_patient" if rng.random() < 0.5 else "wrong_random"
            mrn = (other.pm_mrn if rng.random() < 0.5 else other.ehr_mrn) if mrn_kind == "wrong_other_patient" else str(rng.randint(10000, 999999))
        if case in ("no_mrn", "old_phone", "namesake"):
            mrn, mrn_kind = None, None
        phone = None
        if (rng.random() < PHONE_P[layout] or case == "old_phone") and case != "namesake":
            phone = pt.cell_phone if pt.cell_phone and rng.random() < 0.4 else pt.home_phone
        if case == "old_phone":
            phone = f"3075550{rng.randint(100, 199)}"  # an outdated number: 307 is not used for patients
        dob = dob_date(pt.dob)
        if case == "dob_typo":
            dob = dob.replace(day=dob.day + 1 if dob.day < 28 else dob.day - 1)
        printed.append(Printed(
            first=pt.first, middle=pt.middle, last=pt.last, dob=dob, sex=pt.sex,
            name_style=rng.choice(NAME_STYLES[layout]), dob_style=rng.choice(DOB_STYLES[layout]),
            mrn=mrn, mrn_label=rng.choice(MRN_LABELS[layout]), phone=phone,
            phone_label=rng.choice(PHONE_LABELS[layout]), mrn_kind=mrn_kind,
        ))
    plan_third(seed, i, layout, case, pts, printed)

    quality = pick(rng, QUALITY_WEIGHTS)
    container = "pdf_text" if quality == "text_pdf" else pick(rng, CONTAINER_WEIGHTS)
    reported = GENERATED - timedelta(days=rng.randint(0, 3), hours=rng.randint(0, 10), minutes=rng.randint(0, 59))
    collected = (reported - timedelta(days=rng.randint(0, 7))).replace(hour=rng.randint(6, 15), minute=rng.randint(0, 59))
    if collected > reported:
        collected = reported - timedelta(hours=3)
    sender = dict(rng.choice(SENDERS[layout]))
    fax_header = None
    if quality != "text_pdf":
        t = reported + timedelta(hours=rng.randint(0, 20))
        fax_header = rng.choice([
            f"From: {sender['short']} {sender['fax']}   Page {{i}}/{{n}}   {t.strftime('%m/%d/%Y %H:%M')}",
            f"{t.strftime('%m/%d/%Y %H:%M')}   FROM: {sender['fax']}  {sender['short']}   TO: 2085550100   P.{{i:03d}}/{{n:03d}}",
            f"{t.strftime('%b-%d-%Y %I:%M%p').upper()}  {sender['short']}  {sender['fax']}  p{{i}}",
        ])
    # Daily batches: page style, long result histories, identifier lines blotted out (fax copies only:
    # an emailed PDF's text layer would still carry the text under a smear).
    batch_style, obscure, long_patients = "per_page", set(), set()
    if layout == "daily_batch":
        n = len(pts)
        batch_style = pick(rng, BATCH_STYLE_MULTI if n > 1 else BATCH_STYLE_SINGLE)
        long_patients = {k for k in range(n) if rng.random() < 0.3}
        if quality != "text_pdf":
            if n > 1 and rng.random() < 0.3:
                if rng.random() < 0.5:  # one page: a patient's first page, or a continuation page
                    obscure = {(rng.randrange(n), rng.choice([0, 0, 1]))}
                else:  # all of one later patient's pages: the file then looks like fewer patients
                    k = rng.randrange(1, n)
                    obscure = {(k, j) for j in range(6)}
            elif n == 1 and rng.random() < 0.08:
                obscure = {(0, 1)}
    return {
        "i": i, "rng": rng, "layout": layout, "case": case, "patients": pts, "printed": printed,
        "quality": quality, "container": container, "reported": reported, "collected": collected,
        "sender": sender, "fax_header": fax_header,
        "cover": quality != "text_pdf" and rng.random() < 0.35,
        "cover_names_patient": rng.random() < 0.4,
        "profile": ckd_profile(rng),
        "batch_style": batch_style, "obscure": obscure, "long_patients": long_patients,
    }


def expected_pages(layout: str, meta: list[dict], decisions: list[str], keys: list[str]) -> tuple[str, str, list]:
    """
    The ideal page rules applied to what is printed: ("single" | "split" | "review", why, per page the
    roster key it should be filed to, or None). Mirrors src/platform/modules/intake/pages.ts.
    """
    batch = layout == "daily_batch"
    review = lambda why: ("review", why, [None] * len(meta))  # noqa: E731
    result = [(i, m) for i, m in enumerate(meta) if m["role"] == "result"]
    if any(len(m["owners"]) > 1 for _, m in result):
        return review("a page shows more than one patient")
    if batch and any(not set(m["owners"]) & set(m["shown"]) for _, m in result):
        return review("batch sender: a result page without a readable identifier")
    owner_of: dict[int, int] = {}
    cur = None
    for i, m in result:
        if m["owners"]:
            o = m["owners"][0]
            if o != cur and o not in m["shown"]:
                return review("a patient's first page has no readable identifier")
            cur = o
        if cur is None:
            return review("a page before any patient")
        owner_of[i] = cur
    order = [owner_of[i] for i, _ in result]
    runs = [o for j, o in enumerate(order) if j == 0 or order[j - 1] != o]
    if len(runs) != len(set(runs)):
        return review("a patient's pages are not contiguous")
    single = len(set(order)) == 1
    out = []
    for i, m in enumerate(meta):
        o = owner_of.get(i, order[0] if single else None)  # cover: filed with a single-patient document
        out.append(keys[o] if o is not None and decisions[o] == "auto" else None)
    return ("single" if single else "split"), "", out


def build_one(args: tuple) -> dict:
    i, seed, roster, outside, out = args
    plan = plan_doc(i, seed, roster, outside)
    rng: random.Random = plan["rng"]
    doc_id = f"D{i + 1:05d}"
    report = plan["case"] == "multi_report"
    spec = DocSpec(doc_id=doc_id, layout=plan["layout"], sender=plan["sender"],
                   patients=plan["printed"][:1] if report else plan["printed"],
                   collected=plan["collected"], reported=plan["reported"], rng=rng, profile=plan["profile"],
                   cover=plan["cover"], cover_names_patient=plan["cover_names_patient"], fax_header=plan["fax_header"],
                   batch_style=plan["batch_style"], obscure=plan["obscure"], long_patients=plan["long_patients"])
    more = tuple(
        DocSpec(doc_id=doc_id, layout=plan["layout"], sender=plan["sender"], patients=[p], collected=plan["collected"],
                reported=plan["reported"], rng=rng, profile=plan["profile"])
        for p in plan["printed"][1:]
    ) if report else ()
    tmp_pdf = os.path.join(out, "docs", f"{doc_id}.src.pdf")
    pages, page_meta = render(spec, tmp_pdf, with_fax_header=plan["quality"] != "text_pdf", more=more)
    if plan["quality"] == "text_pdf":
        final = os.path.join(out, "docs", f"{doc_id}.pdf")
        os.replace(tmp_pdf, final)
    else:
        nrng = np.random.default_rng(seed * 100_003 + i)
        imgs = fax_pages(tmp_pdf, plan["quality"], rng, nrng)
        if plan["container"] == "image_pdf":
            final = os.path.join(out, "docs", f"{doc_id}.pdf")
            save_image_pdf(imgs, final, plan["quality"])
        else:
            final = os.path.join(out, "docs", f"{doc_id}.tif")
            save_tiff(imgs, final, plan["quality"], "group4" if plan["container"] == "tiff_g4" else "group3")
        os.remove(tmp_pdf)

    p0 = plan["printed"][0]
    multi = len(plan["printed"]) > 1
    if multi:
        decision, hit = "ambiguous", None
        intended = "multiple"
    else:
        decision, hit = expected_decision(p0, roster)
        intended = plan["patients"][0].key if plan["case"] not in ("not_in_roster", "namesake") else "not_in_roster"
    markers = sorted(spec.abnormal_markers)
    keys = [p.key for p in plan["patients"]]
    decisions = [expected_decision(p, roster)[0] for p in plan["printed"]]
    labels = [spec.name_label] * len(keys) if not report else [spec.name_label] + [m.name_label for m in more]
    decisions_nd = [expected_decision_name_dob(p, roster, labels[k])[0] for k, p in enumerate(plan["printed"])]
    if plan["case"] == "not_in_roster":
        decisions = ["none"]
        decisions_nd = ["none"]
    exp_doc, exp_why, exp_pages = expected_pages(plan["layout"], page_meta, decisions, keys)
    _, _, exp_pages_nd = expected_pages(plan["layout"], page_meta, decisions_nd, keys)
    name = lambda idx: [keys[x] for x in idx]  # noqa: E731
    page_truth = [
        {"page": n + 1, "role": m["role"], "owners": name(m["owners"]), "shown": name(m["shown"]),
         "blotted": name(m["blotted"]), "names": name(m["names"]), "expected_filed_to": exp_pages[n],
         "expected_filed_to_name_dob": exp_pages_nd[n]}
        for n, m in enumerate(page_meta)
    ]
    patients_truth = [
        {"key": keys[k], "in_roster": plan["case"] not in ("not_in_roster", "namesake"), "expected_decision": decisions[k],
         "expected_decision_name_dob": decisions_nd[k],
         "pages": [t["page"] for t in page_truth if keys[k] in t["owners"]]}
        for k in range(len(keys))
    ]
    truth = {
        "id": doc_id,
        "file": os.path.basename(final),
        "layout": plan["layout"],
        "case": plan["case"],
        "quality": plan["quality"],
        "container": plan["container"],
        "pages": pages,
        "cover_sheet": plan["cover"],
        "intended_patient": intended,
        "expected_decision": decision,
        # The same with the optional INTAKE_MATCH_RULE=name_dob (exact name + DOB may be enough).
        "expected_decision_name_dob": "ambiguous" if multi else ("none" if plan["case"] == "not_in_roster" else decisions_nd[0]),
        "expected_match_key": hit,
        "name_label": spec.name_label,
        "kind": spec.kind,
        "sender": {"name": plan["sender"]["name"], "aliases": [plan["sender"]["name"], plan["sender"]["short"]]},
        "collection_date": mmddyyyy(plan["collected"].date()),
        "abnormal": {"flagged": bool(markers), "critical": any(m in ("HH", "LL", "CRITICAL") for m in markers), "markers": markers},
        "printed": {
            "first": p0.first, "last": p0.last, "name_style": p0.name_style,
            "dob": mmddyyyy(p0.dob), "dob_style": p0.dob_style,
            "mrn": p0.mrn, "mrn_kind": p0.mrn_kind, "mrn_label": p0.mrn_label if p0.mrn else None,
            "phone": p0.phone, "phone_label": p0.phone_label if p0.phone else None,
            # Third identifier as printed (a full fictional SSN is not repeated here: last 4 only).
            "ssn4": p0.third.get("ssn4"), "ssn_kind": p0.third.get("ssn_kind"), "ssn_style": p0.third.get("ssn_style"),
            "address": p0.address_lines, "address_kind": p0.third.get("address_kind"),
            "address_labelled": bool(p0.address_lines and p0.address_label),
        },
        "patients_on_document": len(plan["printed"]),
        "batch_style": plan["batch_style"] if plan["layout"] == "daily_batch" else None,
        "obscured": bool(any(t["blotted"] for t in page_truth)),
        "expected_pages_decision": exp_doc,
        "expected_pages_why": exp_why,
        "patients_truth": patients_truth,
        "page_truth": page_truth,
    }
    with open(os.path.join(out, "truth", f"{doc_id}.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, indent=1)
    return {"id": doc_id, "layout": plan["layout"], "quality": plan["quality"], "decision": decision}


# Cases the small Veradigm sandbox roster can produce (see load_sandbox_roster).
SANDBOX_CASE_WEIGHTS = {
    "normal": 50, "no_mrn": 10, "wrong_mrn": 6, "not_in_roster": 8, "same_name_diff_dob": 8,
    "hyphen_apostrophe": 8, "dob_typo": 3, "multi_patient": 5,
}


def load_sandbox_roster(path: str) -> list[Patient]:
    """Synthetic patients that exist in the Veradigm sandbox (JSON from the sandbox setup script)."""
    rows = json.load(open(path, encoding="utf-8"))
    names: dict[str, int] = {}
    for r in rows:
        names[(r["first"] + " " + r["last"]).lower()] = names.get((r["first"] + " " + r["last"]).lower(), 0) + 1
    roster = []
    for r in rows:
        y, m, d = r["dob"].split("-")
        tags = []
        if names[(r["first"] + " " + r["last"]).lower()] > 1:
            tags.append("same_name_diff_dob")
        if "-" in r["last"] or " " in r["last"]:
            tags.append("hyphen")
        roster.append(Patient(
            key=r["key"], patient_id=str(r.get("pmId") or ""), chart_patient_id=str(r["ehrId"]),
            first=r["first"], middle="", last=r["last"], dob=f"{m}/{d}/{y}", sex=r["sex"],
            pm_mrn=str(r.get("pmMrn") or ""), ehr_mrn=str(r.get("ehrMrn") or r.get("patientNumber") or ""),
            home_phone=r["phone"], cell_phone="", tags=tags,
        ))
    return roster


def generate(args: argparse.Namespace) -> int:
    global CASE_WEIGHTS
    out = os.path.abspath(args.out)
    for sub in ("docs", "truth"):
        os.makedirs(os.path.join(out, sub), exist_ok=True)
    sender_numbers()
    roster, outside = build_roster(max(args.roster, 80), random.Random(args.seed))
    if args.roster_file:
        roster = load_sandbox_roster(args.roster_file)
        CASE_WEIGHTS = SANDBOX_CASE_WEIGHTS
    # Addresses, previous addresses, SSN last 4 and namesakes, from their own RNG (see add_third_ids).
    add_third_ids(roster, outside, random.Random(f"{args.seed}:third"))
    with open(os.path.join(out, "roster.json"), "w", encoding="utf-8") as f:
        json.dump([p.to_json() for p in roster], f, indent=1)
    with open(os.path.join(out, "outside.json"), "w", encoding="utf-8") as f:
        json.dump([p.to_json() for p in outside], f, indent=1)
    t = time.time()
    jobs = [(i, args.seed, roster, outside, out) for i in range(args.docs)]
    counts: dict[str, dict[str, int]] = {"layout": {}, "quality": {}, "decision": {}}
    with Pool(args.workers) as pool:
        for n, r in enumerate(pool.imap_unordered(build_one, jobs, chunksize=4), 1):
            for k in counts:
                counts[k][r[k]] = counts[k].get(r[k], 0) + 1
            if n % 100 == 0 or n == args.docs:
                print(f"[synth] {n}/{args.docs} documents, {int(time.time() - t)} s", flush=True)
    manifest = {"seed": args.seed, "roster": len(roster), "outside": len(outside), "docs": args.docs,
                "generated_for": GENERATED.isoformat(), "counts": counts,
                "note": "Synthetic data only. Every person, number and organization is invented."}
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print(json.dumps(counts, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate")
    g.add_argument("--roster", type=int, default=300)
    g.add_argument("--docs", type=int, default=1000)
    g.add_argument("--seed", type=int, default=42)
    g.add_argument("--out", required=True)
    g.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    g.add_argument("--roster-file", default="", help="JSON roster of sandbox patients (documents use only these, plus outside people)")
    args = ap.parse_args()
    if args.roster < 80 and not args.roster_file:
        print("--roster must be at least 80 (hard cases take ~70 slots)", file=sys.stderr)
        return 2
    return generate(args)


if __name__ == "__main__":
    sys.exit(main())
