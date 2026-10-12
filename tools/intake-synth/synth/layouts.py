"""
Six fictional document layouts rendered with reportlab, plus a fax cover sheet.

  reference_lab   national reference-lab style: letterhead, two-column patient/specimen block,
                  TEST/RESULT/FLAG/REFERENCE/UNITS table, optional methodology page
  hospital_lab    hospital lab: banner with hospital MRN or ours, "(H)/(L)/(C)" flags, critical callback
  small_clinic    small clinic point-of-care results: loose labels, "*H" flags, patient phone as "Phone:"
  daily_batch     dense Courier daily batch (stand-in for "Express Lab"); one patient or several
  imaging         renal ultrasound report: RE/D.O.B./Exam Date, findings, impression
  consult         consult letter from a specialist practice to the nephrologist

All sender names, addresses, providers and numbers are invented; no real logos or trademarks.
A layout draws into a Doc, which records draw operations per page so that page totals
("Page 1 of 2", fax header "P.1/3") are known before anything is drawn.
"""
from __future__ import annotations

import random
import textwrap
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Callable, Optional

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

from .content import Result, consult_body, lab_panels, renal_ultrasound

W, H = letter
TOP = H - 54
BOTTOM = 60

# ── Senders (fictional) ──────────────────────────────────────────────────────

SENDERS: dict[str, list[dict]] = {
    "reference_lab": [
        {"name": "Larkspur Reference Laboratories", "short": "LARKSPUR REF LAB", "city": "Meridian, ID 83642"},
        {"name": "Bitterbrush Diagnostic Labs", "short": "BITTERBRUSH DX", "city": "Nampa, ID 83651"},
    ],
    "hospital_lab": [
        {"name": "Camas Prairie Regional Medical Center", "short": "CAMAS PRAIRIE RMC", "city": "Caldwell, ID 83605"},
        {"name": "Syringa Valley Hospital", "short": "SYRINGA VALLEY HOSP", "city": "Mountain Home, ID 83647"},
    ],
    "small_clinic": [
        {"name": "Juniper Flats Family Clinic", "short": "JUNIPER FLATS FC", "city": "Emmett, ID 83617"},
        {"name": "Sweetwater Community Health", "short": "SWEETWATER CHC", "city": "Payette, ID 83661"},
    ],
    "daily_batch": [
        {"name": "Sawtooth Rapid Lab", "short": "SAWTOOTH RAPID LAB", "city": "Boise, ID 83704"},
    ],
    "imaging": [
        {"name": "Silver Creek Imaging Associates", "short": "SILVER CREEK IMAGING", "city": "Eagle, ID 83616"},
        {"name": "Kestrel Valley Radiology", "short": "KESTREL VALLEY RAD", "city": "Kuna, ID 83634"},
    ],
    "consult": [
        {"name": "Basalt Ridge Vascular Surgery", "short": "BASALT RIDGE VASC", "city": "Boise, ID 83706", "spec": "vascular"},
        {"name": "Cottonwood Heart Associates", "short": "COTTONWOOD HEART", "city": "Meridian, ID 83646", "spec": "cardiology"},
        {"name": "High Desert Endocrine Clinic", "short": "HIGH DESERT ENDO", "city": "Boise, ID 83702", "spec": "endocrinology"},
        {"name": "Kestrel Urology Group", "short": "KESTREL UROLOGY", "city": "Nampa, ID 83686", "spec": "urology"},
        {"name": "Ponderosa Transplant Center", "short": "PONDEROSA TXP", "city": "Boise, ID 83712", "spec": "transplant"},
    ],
}
PROVIDERS = ["Rowan Hale", "Imani Castell", "Teodor Quill", "Priya Vanterpool", "Mattias Brook", "Lucinda Farr"]
SIGNERS = ["Corwin Ashdale, MD", "Elspeth Moraine, MD", "Basil Thorncroft, DO", "Junia Pell, MD", "Odessa Wren, MD"]
CLINIC = "Idaho Kidney Institute"
CLINIC_FAX = "(208) 555-0100"


def phone_fmt(d: str, style: int) -> str:
    if not d:
        return ""
    return [f"({d[:3]}) {d[3:6]}-{d[6:]}", f"{d[:3]}-{d[3:6]}-{d[6:]}", f"{d[:3]}.{d[3:6]}.{d[6:]}", d][style % 4]


def date_fmt(d: date, style: str) -> str:
    return {
        "mdy": d.strftime("%m/%d/%Y"),
        "mdy_short": f"{d.month}/{d.day}/{d.year}",
        "iso": d.strftime("%Y-%m-%d"),
        "mon": d.strftime("%b %d, %Y").replace(" 0", " "),
        "month": d.strftime("%B %d, %Y").replace(" 0", " "),
        "dmy": d.strftime("%d-%b-%Y"),
        "mdyy": d.strftime("%m/%d/%y"),
    }[style]


def name_fmt(first: str, middle: str, last: str, style: str) -> str:
    mi = f" {middle}" if middle else ""
    return {
        "LAST, FIRST M": f"{last.upper()}, {first.upper()}{mi.upper()}",
        "LAST,FIRST": f"{last.upper()},{first.upper()}",
        "Last, First": f"{last}, {first}",
        "First M. Last": f"{first}{mi + '.' if middle else ''} {last}",
        "First Last": f"{first} {last}",
        "FIRST LAST": f"{first.upper()} {last.upper()}",
    }[style]


# ── Document spec (what generate.py hands a layout) ─────────────────────────

@dataclass
class Printed:
    """Identifiers exactly as printed for one patient."""
    first: str
    middle: str
    last: str
    dob: date
    sex: str
    name_style: str
    dob_style: str
    mrn: Optional[str]
    mrn_label: str
    phone: Optional[str]
    phone_label: str
    # pm | ehr | foreign | wrong_other_patient | wrong_random | None
    mrn_kind: Optional[str] = None
    # Third identifier as printed (generate.py plan_third). address_lines: the street line and the
    # "City, ST 12345" line, or one line with both; ssn_text: "***-**-1234", "XXX-XX-1234", "1234"
    # (with a "Last 4" label) or a full fictional SSN (900-999 area numbers are never issued).
    address_lines: Optional[list] = None
    address_label: str = "Address:"
    ssn_text: Optional[str] = None
    ssn_label: str = "SSN:"
    # Truth only (never printed as such): {"address": {number, zip, name, dir, suffix}, "address_kind":
    # current | outdated | wrong, "ssn4", "ssn_kind": right | wrong | not_on_file, "ssn_style"}.
    third: dict = field(default_factory=dict)


@dataclass
class DocSpec:
    doc_id: str
    layout: str
    sender: dict
    patients: list[Printed]
    collected: datetime
    reported: datetime
    rng: random.Random
    profile: dict
    cover: bool = False
    cover_names_patient: bool = False
    fax_header: Optional[str] = None  # format with {i}, {n}
    # Daily batch only: "per_page" (each patient starts a page; continuation pages repeat the
    # patient line), "no_repeat" (each patient starts a page; continuation pages don't repeat it),
    # "packed" (patients follow each other on the same page).
    batch_style: str = "per_page"
    # (patient index, nth page of that patient) whose identifier lines are blotted out (fax only).
    obscure: set = field(default_factory=set)
    # Patients with a long result history (their results run over a second page).
    long_patients: set = field(default_factory=set)
    # Filled in by the layout:
    abnormal_markers: set = field(default_factory=set)
    kind: str = ""
    # The label printed before the patient's name in the report body ("Patient Name:", "RE:", ...).
    name_label: str = ""


class Doc:
    """
    Records draw ops per page; `put` draws at the cursor, `ln` moves it down.
    Per page it also records ground truth: `owners` (patient indexes whose content is on the page),
    `shown` (patients whose name + DOB or MRN is readable on it) and `blotted` (patients whose
    identifier lines were blotted out). Text is attributed to `owner` (None = no patient).
    """

    def __init__(self, on_page: Optional[Callable[["Doc"], None]] = None):
        self.pages: list[list[tuple]] = []
        self.owners: list[set] = []
        self.shown: list[set] = []
        self.blotted: list[set] = []
        self.owner: Optional[int] = None
        self.patient_page: dict[int, int] = {}
        self.on_page = on_page
        self.y = TOP
        self.new_page()

    def new_page(self) -> None:
        self.pages.append([])
        self.owners.append(set())
        self.shown.append(set())
        self.blotted.append(set())
        self.y = TOP
        if self.owner is not None:
            self.patient_page[self.owner] = self.patient_page.get(self.owner, 0) + 1
        if self.on_page:
            self.on_page(self)

    def put(self, x: float, s: str, font: str = "Helvetica", size: float = 10, align: str = "left") -> None:
        self.pages[-1].append(("text", x, self.y, s, font, size, align))
        if self.owner is not None:
            self.owners[-1].add(self.owner)

    def mark_shown(self, k: int = 0) -> None:
        self.shown[-1].add(k)

    def blot(self, x: float, y: float, w: float, h: float, k: int) -> None:
        """A black smear over identifier lines (fax dropout / ink blot): unreadable by design."""
        self.pages[-1].append(("blot", x, y, w, h))
        self.blotted[-1].add(k)
        self.shown[-1].discard(k)

    def page_meta(self) -> list[dict]:
        return [{"owners": sorted(o), "shown": sorted(s), "blotted": sorted(b)} for o, s, b in zip(self.owners, self.shown, self.blotted)]

    def hline(self, x0: float = 54, x1: float = W - 54, width: float = 0.8) -> None:
        self.pages[-1].append(("line", x0, self.y, x1, self.y, width))

    def box(self, x: float, y: float, w: float, h: float) -> None:
        self.pages[-1].append(("rect", x, y, w, h))

    def ln(self, h: float = 13) -> None:
        self.y -= h
        if self.y < BOTTOM:
            self.new_page()

    def need(self, h: float) -> None:
        if self.y - h < BOTTOM:
            self.new_page()

    def para(self, s: str, x: float = 72, width: int = 92, font: str = "Times-Roman", size: float = 11, lead: float = 14) -> None:
        for line in textwrap.wrap(s, width):
            self.put(x, line, font, size)
            self.ln(lead)


def render_pdf(path: str, parts: list[tuple[Doc, Optional[Callable]]], fax_header: Optional[str]) -> int:
    """Draw every part's pages into one PDF. Each part may have a footer(c, i, n) for its own pages."""
    c = canvas.Canvas(path, pagesize=letter, invariant=1)
    c.setTitle("Synthetic test document")
    c.setAuthor("intake-synth")
    total = sum(len(d.pages) for d, _ in parts)
    page_no = 0
    for doc, footer in parts:
        for i, ops in enumerate(doc.pages, 1):
            page_no += 1
            for op in ops:
                if op[0] == "text":
                    _, x, y, s, font, size, align = op
                    c.setFont(font, size)
                    if align == "right":
                        c.drawRightString(x, y, s)
                    elif align == "center":
                        c.drawCentredString(x, y, s)
                    else:
                        c.drawString(x, y, s)
                elif op[0] == "line":
                    c.setLineWidth(op[5])
                    c.line(op[1], op[2], op[3], op[4])
                elif op[0] == "rect":
                    c.setLineWidth(0.8)
                    c.rect(op[1], op[2], op[3], op[4])
                elif op[0] == "blot":
                    c.setFillGray(0)
                    c.rect(op[1], op[2], op[3], op[4], stroke=0, fill=1)
            if footer:
                footer(c, i, len(doc.pages))
            if fax_header:
                c.setFont("Courier", 8)
                c.drawString(30, H - 18, fax_header.format(i=page_no, n=total))
            c.showPage()
    c.save()
    return total


# ── Shared pieces ────────────────────────────────────────────────────────────

def flag_text(r: Result, style: str) -> str:
    if not r.flag:
        return ""
    if style == "paren":
        return {"HH": "(C)", "LL": "(C)"}.get(r.flag, f"({r.flag})")
    if style == "star":
        return f"*{r.flag}"
    return r.flag


def record_flags(spec: DocSpec, rows: list[Result]) -> None:
    for r in rows:
        if r.flag:
            spec.abnormal_markers.add(r.flag)


def mrn_line(p: Printed) -> str:
    return f"{p.mrn_label} {p.mrn}" if p.mrn else ""


def phone_line(p: Printed, style: int) -> str:
    return f"{p.phone_label} {phone_fmt(p.phone, style)}" if p.phone else ""


def ssn_line(p: Printed) -> str:
    return f"{p.ssn_label} {p.ssn_text}" if p.ssn_text else ""


def address_rows(p: Printed, labelled: bool = True) -> list[str]:
    """The address as printed: 'Address: <street>[, City, ST 12345]' plus a city line when split."""
    if not p.address_lines:
        return []
    first = f"{p.address_label} {p.address_lines[0]}" if labelled and p.address_label else p.address_lines[0]
    return [first] + list(p.address_lines[1:])


def cover_sheet(spec: DocSpec) -> Doc:
    rng = spec.rng
    d = Doc()
    s = spec.sender
    d.put(W / 2, "FAX", "Helvetica-Bold", 36, "center")
    d.ln(30)
    d.put(W / 2, s["name"], "Helvetica-Bold", 14, "center")
    d.ln(16)
    d.put(W / 2, f"{s['city']}   Phone {phone_fmt(s['phone'], 0)}   Fax {phone_fmt(s['fax'], 0)}", "Helvetica", 9, "center")
    d.ln(40)
    p = spec.patients[0]
    re_line = name_fmt(p.first, p.middle, p.last, "LAST, FIRST M") if spec.cover_names_patient else rng.choice(
        ["Lab results", "Results for your patient", "Requested records", "Report attached"])
    rows = [("To:", CLINIC), ("Attn:", f"Dr. {rng.choice(PROVIDERS)}"), ("Fax:", CLINIC_FAX),
            ("From:", s["name"]), ("Date:", spec.reported.strftime("%m/%d/%Y")),
            ("Pages:", "{pages} (including cover)"), ("RE:", re_line)]
    for k, v in rows:
        d.put(90, k, "Helvetica-Bold", 12)
        d.put(170, v, "Helvetica", 12)
        d.ln(22)
    d.ln(30)
    d.para("CONFIDENTIALITY NOTICE: This facsimile contains protected health information intended only for the "
           "recipient named above. If you received it in error, notify the sender by telephone and destroy all copies. "
           "Further disclosure is prohibited by federal and state law.", x=72, width=88, font="Helvetica", size=9, lead=12)
    return d


def _fill_pages(doc: Doc, total: int) -> None:
    for ops in doc.pages:
        for i, op in enumerate(ops):
            if op[0] == "text" and "{pages}" in op[3]:
                ops[i] = op[:3] + (op[3].replace("{pages}", str(total)),) + op[4:]


# ── 1. Reference lab ─────────────────────────────────────────────────────────

def reference_lab(spec: DocSpec) -> tuple[Doc, Callable]:
    rng = spec.rng
    s = spec.sender
    p = spec.patients[0]
    name_label = rng.choice(["Patient Name:", "Patient:", "Patient Name:"])
    spec.name_label = name_label
    dob_label = rng.choice(["DOB:", "Date of Birth:", "Birthdate:"])
    banner_name = name_fmt(p.first, p.middle, p.last, p.name_style)
    banner_dob = date_fmt(p.dob, p.dob_style)
    spec_id = f"{s['short'][:2]}{rng.randint(1000000, 9999999)}"
    doctor = rng.choice(PROVIDERS)

    def page_top(d: Doc) -> None:
        d.put(54, s["name"].upper(), "Helvetica-Bold", 14)
        d.put(W - 54, "LABORATORY REPORT", "Helvetica-Bold", 11, "right")
        d.ln(13)
        d.put(54, f"{s['city']}  Tel {phone_fmt(s['phone'], 1)}  Fax {phone_fmt(s['fax'], 1)}", "Helvetica", 8)
        d.ln(10)
        d.hline()
        d.ln(16)
        if len(d.pages) > 1:
            d.put(54, f"{name_label} {banner_name}", "Helvetica", 9)
            d.put(330, f"{dob_label} {banner_dob}", "Helvetica", 9)
            d.mark_shown()
            d.ln(18)

    d = Doc(page_top)
    d.owner = 0
    d.mark_shown()
    left = [f"{name_label} {banner_name}", f"{dob_label} {banner_dob}     Sex: {p.sex}", mrn_line(p), phone_line(p, rng.randint(0, 3)),
            ssn_line(p), *address_rows(p)]
    right = [f"Specimen ID: {spec_id}", f"Collected: {spec.collected.strftime('%m/%d/%Y %H:%M')}",
             f"Received: {spec.collected.strftime('%m/%d/%Y')} {rng.randint(9, 14)}:{rng.randint(10, 59)}",
             f"Reported: {spec.reported.strftime('%m/%d/%Y %H:%M')}", f"Ordering: {doctor}, MD", f"Client: {CLINIC}"]
    left = [x for x in left if x]
    top_y = d.y
    for i in range(max(len(left), len(right))):
        if i < len(left):
            d.put(54, left[i], "Helvetica-Bold" if i == 0 else "Helvetica", 10)
        if i < len(right):
            d.put(330, right[i], "Helvetica", 9)
        d.ln(13)
    d.box(48, d.y + 6, W - 96, top_y - d.y + 6)
    d.ln(12)
    cols = [54, 250, 320, 370, 470]
    for x, h in zip(cols, ["TEST", "RESULT", "FLAG", "REFERENCE", "UNITS"]):
        d.put(x, h, "Helvetica-Bold", 9)
    d.ln(4)
    d.hline(width=0.5)
    d.ln(12)
    for panel, rows in lab_panels(rng, spec.profile, "reference_lab"):
        d.need(30)
        d.put(54, panel.upper(), "Helvetica-Bold", 9)
        d.ln(12)
        record_flags(spec, rows)
        for r in rows:
            d.put(64, r.test, "Helvetica", 9)
            d.put(250, r.value, "Helvetica-Bold" if r.flag else "Helvetica", 9)
            d.put(320, flag_text(r, "plain"), "Helvetica-Bold", 9)
            d.put(370, r.ref, "Helvetica", 9)
            d.put(470, r.units, "Helvetica", 9)
            d.ln(12)
        d.ln(6)
    if any(f in spec.abnormal_markers for f in ("HH", "LL")):
        d.put(54, f"CRITICAL RESULT called to {rng.choice(['clinic RN', 'Dr. ' + doctor, 'office staff'])} "
                  f"at {spec.reported.strftime('%H:%M')}, read back verified.", "Helvetica-Bold", 9)
        d.ln(14)
        spec.abnormal_markers.add("CRITICAL")
    if rng.random() < 0.5:
        d.put(54, "Critical values are telephoned to the ordering client per laboratory policy.", "Helvetica-Oblique", 8)
        d.ln(12)
    if rng.random() < 0.3:
        d.new_page()
        d.put(54, "METHODOLOGY AND COMMENTS", "Helvetica-Bold", 10)
        d.ln(16)
        for t in ["eGFR calculated with the CKD-EPI 2021 equation (race-free).",
                  "Potassium may be falsely elevated in hemolyzed specimens.",
                  "Reference intervals are established for adults 18 years and older.",
                  "Results relate only to the specimen as received."]:
            d.para(t, x=54, width=100, font="Helvetica", size=9, lead=12)
    d.ln(8)
    d.put(54, f"Performing Lab: {s['name']}, {s['city']}. Medical Director: {rng.choice(SIGNERS)}", "Helvetica", 8)
    d.ln(12)

    def footer(c, i, n):
        c.setFont("Helvetica", 8)
        c.drawRightString(W - 54, 36, f"Page {i} of {n}")
        c.drawString(54, 36, f"Final report  {spec_id}")

    spec.kind = "lab_result"
    return d, footer


# ── 2. Hospital lab ──────────────────────────────────────────────────────────

def hospital_lab(spec: DocSpec) -> tuple[Doc, Callable]:
    rng = spec.rng
    s = spec.sender
    p = spec.patients[0]
    acct = f"A{rng.randint(10000000, 99999999)}"
    dob = date_fmt(p.dob, p.dob_style)
    age = spec.collected.year - p.dob.year
    pname = name_fmt(p.first, p.middle, p.last, p.name_style)
    spec.name_label = "Patient:"

    def page_top(d: Doc) -> None:
        d.put(W / 2, s["name"], "Times-Bold", 15, "center")
        d.ln(15)
        d.put(W / 2, f"Department of Laboratory Medicine  -  {s['city']}  -  Phone {phone_fmt(s['phone'], 0)}", "Times-Roman", 9, "center")
        d.ln(18)
        d.put(54, f"Patient: {pname}", "Times-Bold", 11)
        if p.mrn:
            d.put(330, f"{p.mrn_label} {p.mrn}", "Times-Roman", 10)
        d.put(470, f"Acct #: {acct}", "Times-Roman", 10)
        d.ln(13)
        d.put(54, f"Birthdate: {dob}", "Times-Roman", 10)
        d.put(200, f"Age/Sex: {age}/{p.sex}", "Times-Roman", 10)
        d.put(330, "Location: Outpatient Lab", "Times-Roman", 10)
        d.mark_shown()
        d.ln(13)
        if p.phone:
            d.put(54, phone_line(p, 0), "Times-Roman", 10)
            d.ln(13)
        if p.ssn_text:
            d.put(54, ssn_line(p), "Times-Roman", 10)
            d.ln(13)
        for row in address_rows(p):
            d.put(54, row, "Times-Roman", 10)
            d.ln(13)
        d.hline()
        d.ln(16)

    d = Doc(page_top)
    d.owner = 0
    d.put(54, rng.choice(["FINAL LAB RESULTS", "LABORATORY RESULTS - FINAL", "Lab Results Report"]), "Times-Bold", 12)
    d.ln(15)
    d.put(54, f"Collection Date/Time: {spec.collected.strftime('%m/%d/%Y %H:%M')}", "Times-Roman", 10)
    d.put(330, f"Resulted: {spec.reported.strftime('%m/%d/%Y %H:%M')}", "Times-Roman", 10)
    d.ln(13)
    d.put(54, f"Ordering Provider: {rng.choice(PROVIDERS)}, MD  ({CLINIC})", "Times-Roman", 10)
    d.ln(20)
    criticals = []
    for panel, rows in lab_panels(rng, spec.profile, "hospital_lab"):
        d.need(30)
        d.put(54, panel, "Times-Bold", 10)
        d.ln(13)
        record_flags(spec, rows)
        for r in rows:
            d.put(66, r.test, "Times-Roman", 10)
            d.put(270, f"{r.value} {flag_text(r, 'paren')}".strip(), "Times-Bold" if r.flag else "Times-Roman", 10)
            d.put(360, f"{r.ref} {r.units}".strip(), "Times-Roman", 10)
            d.ln(12.5)
            if r.flag in ("HH", "LL"):
                criticals.append(r)
        d.ln(6)
    for r in criticals:
        d.need(28)
        d.put(54, f"** CRITICAL RESULT: {r.test} {r.value} {r.units} called to {CLINIC} RN, read back, "
                  f"{spec.reported.strftime('%m/%d/%Y %H:%M')} **", "Times-Bold", 10)
        d.ln(14)
        spec.abnormal_markers.add("CRITICAL")
    d.ln(6)
    d.put(54, f"Electronically verified by {rng.choice(SIGNERS)} (Laboratory Director)", "Times-Italic", 9)
    d.ln(12)

    def footer(c, i, n):
        c.setFont("Times-Roman", 8)
        c.drawCentredString(W / 2, 34, f"{s['name']} - Confidential patient information - Page {i}/{n}")

    spec.kind = "lab_result"
    return d, footer


# ── 3. Small clinic ──────────────────────────────────────────────────────────

def small_clinic(spec: DocSpec) -> tuple[Doc, Callable]:
    rng = spec.rng
    s = spec.sender
    p = spec.patients[0]
    d = Doc()
    d.owner = 0
    d.put(54, s["name"], "Helvetica-Bold", 13)
    d.ln(13)
    d.put(54, f"{s['city']}   Tel: {phone_fmt(s['phone'], 0)}   Fax: {phone_fmt(s['fax'], 0)}", "Helvetica", 9)
    d.ln(24)
    d.put(54, rng.choice(["In-Office Laboratory Results", "Point of Care Test Results", "Lab Results"]), "Helvetica-Bold", 11)
    d.ln(20)
    name_label = rng.choice(["Name:", "RE:", "Patient:"])
    spec.name_label = name_label
    d.put(54, f"{name_label} {name_fmt(p.first, p.middle, p.last, p.name_style)}", "Helvetica", 10)
    d.ln(14)
    d.put(54, f"{rng.choice(['Date of Birth:', 'DOB:', 'Birthdate:'])} {date_fmt(p.dob, p.dob_style)}", "Helvetica", 10)
    d.mark_shown()
    d.ln(14)
    if p.phone:
        d.put(54, phone_line(p, 2), "Helvetica", 10)
        d.ln(14)
    if p.mrn:
        d.put(54, mrn_line(p), "Helvetica", 10)
        d.ln(14)
    for row in address_rows(p) + ([ssn_line(p)] if p.ssn_text else []):
        d.put(54, row, "Helvetica", 10)
        d.ln(14)
    lbl = rng.choice(["Date of Service:", "Collected:", "Date Collected:"])
    d.put(54, f"{lbl} {date_fmt(spec.collected.date(), rng.choice(['mdy', 'mdy_short']))}", "Helvetica", 10)
    d.ln(22)
    for panel, rows in lab_panels(rng, spec.profile, "small_clinic"):
        d.put(54, panel, "Helvetica-Bold", 10)
        d.ln(14)
        record_flags(spec, rows)
        for r in rows:
            d.put(70, r.test, "Helvetica", 10)
            d.put(300, f"{r.value} {r.units}", "Helvetica", 10)
            d.put(410, flag_text(r, "star"), "Helvetica-Bold", 10)
            d.put(450, f"({r.ref})" if r.ref else "", "Helvetica", 9)
            d.ln(13)
        d.ln(8)
    d.ln(10)
    d.put(54, f"Reviewed by: {rng.choice(SIGNERS)}", "Helvetica", 9)
    d.ln(12)
    d.put(54, f"Please forward to Dr. {rng.choice(PROVIDERS)} at {CLINIC}.", "Helvetica", 9)
    d.ln(12)
    spec.kind = "lab_result"
    return d, None


# ── 4. Daily batch (stand-in for "Express Lab") ──────────────────────────────

ABBR = {"Sodium": "NA", "Potassium": "K", "Chloride": "CL", "CO2": "CO2", "BUN": "BUN", "Creatinine": "CREAT",
        "eGFR": "EGFR", "Glucose": "GLU", "Calcium": "CA", "Phosphorus": "PHOS", "Albumin": "ALB",
        "PTH, Intact": "PTH-I", "Hemoglobin": "HGB", "Hematocrit": "HCT", "WBC": "WBC", "Platelets": "PLT",
        "Hemoglobin A1c": "HBA1C", "Urine Albumin/Creatinine Ratio": "UACR"}


def daily_batch(spec: DocSpec) -> tuple[Doc, Callable]:
    """
    One file, many patients. batch_style "per_page": each patient starts a new page and continuation
    pages repeat the patient line; "no_repeat": new page per patient, continuation pages carry results
    only; "packed": patients follow each other on the same page. Identifier lines listed in
    spec.obscure are blotted out (a fax dropout), and patients in spec.long_patients carry a
    cumulative history that runs onto a second page.
    """
    rng = spec.rng
    s = spec.sender
    batch = f"{spec.reported.strftime('%Y%m%d')}-{rng.randint(1, 9):02d}"
    style = spec.batch_style
    spec.name_label = "PT:"
    acc = {k: f"SR{rng.randint(10000000, 99999999)}" for k in range(len(spec.patients))}
    coll = {k: spec.collected if k == 0 else spec.collected.replace(hour=rng.randint(6, 11), minute=rng.randint(0, 59))
            for k in range(len(spec.patients))}

    def id_lines(d: Doc, k: int, cont: bool) -> None:
        p = spec.patients[k]
        top = d.y
        tail = "  (CONTINUED)" if cont else ""
        d.put(54, f"PT: {name_fmt(p.first, p.middle, p.last, p.name_style):<28} DOB: {date_fmt(p.dob, p.dob_style):<12} SEX: {p.sex}{tail}", "Courier", 8.5)
        d.ln(11)
        ids = f"{p.mrn_label} {p.mrn}" if p.mrn else ""
        d.put(54, f"{ids:<26} ACC#: {acc[k]}   COLL: {coll[k].strftime('%m/%d/%Y %H:%M')}", "Courier", 8.5)
        d.ln(11)
        if p.phone and not cont:
            d.put(54, f"{p.phone_label} {phone_fmt(p.phone, 1)}", "Courier", 8.5)
            d.ln(11)
        if (p.ssn_text or p.address_lines) and not cont:
            extra = [ssn_line(p)] if p.ssn_text else []
            if p.address_lines:
                extra.append(f"{p.address_label} {', '.join(p.address_lines)}")
            d.put(54, "   ".join(extra), "Courier", 8.5)
            d.ln(11)
        d.mark_shown(k)
        if (k, d.patient_page.get(k, 0)) in spec.obscure:
            d.blot(50, d.y + 4, 470, top - d.y + 6, k)

    def page_top(d: Doc) -> None:
        d.put(54, f"{s['name'].upper()} - DAILY BATCH RESULTS", "Courier-Bold", 11)
        d.ln(12)
        d.put(54, f"BATCH: {batch}   RUN DATE: {spec.reported.strftime('%m/%d/%Y')}   CLIENT: {CLINIC.upper()}", "Courier", 8.5)
        d.ln(16)
        if style == "per_page" and d.owner is not None:
            id_lines(d, d.owner, cont=True)
            d.ln(4)

    d = Doc(page_top)
    for k, p in enumerate(spec.patients):
        if style == "packed" or k == 0:
            d.owner = None
            d.need(150)
        else:
            d.owner = None
            d.new_page()
        d.owner = k
        d.patient_page[k] = 0
        d.put(54, "-" * 78, "Courier", 8.5)
        d.ln(11)
        id_lines(d, k, cont=False)
        prof = spec.profile if k == 0 else {**spec.profile, "critical": False}
        for panel, rows in lab_panels(rng, prof, "daily_batch"):
            rows = [r for r in rows if r.test in ABBR or rng.random() < 0.5]
            record_flags(spec, rows)
            for r in rows:
                d.put(54, f"  {ABBR.get(r.test, r.test.upper()[:10]):<10} {r.value:>7}{r.flag:<3} ({r.ref}) {r.units}", "Courier", 8.5)
                d.ln(10.5)
        if k in spec.long_patients:
            d.ln(6)
            d.put(54, "  CUMULATIVE HISTORY (PRIOR RESULTS)", "Courier-Bold", 8.5)
            d.ln(11)
            for m in range(rng.randint(48, 66)):
                when = coll[k].replace(day=1).strftime("%m/%Y")
                test = rng.choice(["CREAT", "EGFR", "K", "BUN", "PHOS", "HGB", "PTH-I", "UACR"])
                d.put(54, f"  {test:<10} {round(rng.uniform(0.6, 60), 1):>7}    PRIOR {m + 1:>2}  {when}", "Courier", 8.5)
                d.ln(10.5)
        d.ln(6)
    d.owner = None
    if style == "packed" or d.y - 30 >= BOTTOM:
        d.put(54, "-" * 78, "Courier", 8.5)
        d.ln(11)
        d.put(54, f"END OF BATCH {batch}   {len(spec.patients)} PATIENT(S)", "Courier", 8.5)

    def footer(c, i, n):
        c.setFont("Courier", 8)
        c.drawString(54, 34, f"PAGE {i} OF {n}")

    spec.kind = "lab_result"
    return d, footer


# ── 5. Imaging ───────────────────────────────────────────────────────────────

def imaging(spec: DocSpec) -> tuple[Doc, Callable]:
    rng = spec.rng
    s = spec.sender
    p = spec.patients[0]
    d = Doc()
    d.owner = 0
    d.put(54, s["name"], "Times-Bold", 15)
    d.ln(14)
    d.put(54, f"{s['city']}  |  Phone {phone_fmt(s['phone'], 0)}  |  Fax {phone_fmt(s['fax'], 0)}", "Times-Roman", 9)
    d.ln(8)
    d.hline()
    d.ln(22)
    d.put(W / 2, rng.choice(["RADIOLOGY REPORT", "DIAGNOSTIC IMAGING REPORT", "ULTRASOUND REPORT"]), "Times-Bold", 13, "center")
    d.ln(24)
    lbl = rng.choice(["RE:", "Patient:", "Patient Name:"])
    spec.name_label = lbl
    d.put(54, f"{lbl} {name_fmt(p.first, p.middle, p.last, p.name_style)}", "Times-Bold", 11)
    d.put(330, f"{rng.choice(['D.O.B.', 'DOB:', 'Date of Birth:'])} {date_fmt(p.dob, p.dob_style)}", "Times-Roman", 11)
    d.mark_shown()
    d.ln(14)
    if p.mrn:
        d.put(54, mrn_line(p), "Times-Roman", 11)
    d.put(330, f"Accession #: {rng.randint(10000000, 99999999)}", "Times-Roman", 11)
    d.ln(14)
    if p.phone:
        d.put(54, phone_line(p, 0), "Times-Roman", 11)
        d.ln(14)
    for row in address_rows(p) + ([ssn_line(p)] if p.ssn_text else []):
        d.put(54, row, "Times-Roman", 11)
        d.ln(14)
    d.put(54, "Exam: US RENAL COMPLETE (RETROPERITONEAL)", "Times-Roman", 11)
    d.ln(14)
    d.put(54, f"{rng.choice(['Exam Date:', 'Date of Exam:', 'Study Date:'])} {date_fmt(spec.collected.date(), rng.choice(['mon', 'mdy', 'month']))}", "Times-Roman", 11)
    d.put(330, f"Referring: Dr. {rng.choice(PROVIDERS)}", "Times-Roman", 11)
    d.ln(24)
    sections, abnormal = renal_ultrasound(rng, spec.profile)
    for head, text in sections:
        d.need(40)
        d.put(54, f"{head}:", "Times-Bold", 11)
        d.ln(14)
        d.para(text, x=72, width=90)
        d.ln(6)
    if abnormal:
        spec.abnormal_markers.add("ABNORMAL")
    d.ln(10)
    d.put(54, f"Electronically signed by {rng.choice(SIGNERS)} on {spec.reported.strftime('%m/%d/%Y %H:%M')}", "Times-Italic", 10)

    def footer(c, i, n):
        c.setFont("Times-Roman", 8)
        c.drawCentredString(W / 2, 34, f"Page {i} of {n}")

    spec.kind = "imaging"
    return d, footer


# ── 6. Consult letter ────────────────────────────────────────────────────────

def consult(spec: DocSpec) -> tuple[Doc, Callable]:
    rng = spec.rng
    s = spec.sender
    p = spec.patients[0]
    d = Doc()
    d.owner = 0
    d.put(W / 2, s["name"], "Times-Bold", 16, "center")
    d.ln(14)
    d.put(W / 2, f"{s['city']}  -  Telephone {phone_fmt(s['phone'], 0)}  -  Facsimile {phone_fmt(s['fax'], 0)}", "Times-Roman", 9, "center")
    d.ln(30)
    d.put(72, date_fmt(spec.reported.date(), "month"), "Times-Roman", 11)
    d.ln(26)
    doc_name = rng.choice(PROVIDERS)
    for line in [f"Dr. {doc_name}", CLINIC, "Nephrology"]:
        d.put(72, line, "Times-Roman", 11)
        d.ln(14)
    d.ln(12)
    d.put(72, f"RE: {name_fmt(p.first, p.middle, p.last, p.name_style)}", "Times-Bold", 11)
    spec.name_label = "RE:"
    d.ln(14)
    d.put(72, f"{rng.choice(['DOB:', 'Date of Birth:', 'DOB'])} {date_fmt(p.dob, p.dob_style)}", "Times-Roman", 11)
    d.mark_shown()
    d.ln(14)
    if p.mrn:
        d.put(72, mrn_line(p), "Times-Roman", 11)
        d.ln(14)
    if p.phone:
        d.put(72, phone_line(p, 0), "Times-Roman", 11)
        d.ln(14)
    for row in address_rows(p) + ([ssn_line(p)] if p.ssn_text else []):
        d.put(72, row, "Times-Roman", 11)
        d.ln(14)
    d.put(72, f"{rng.choice(['Date of Visit:', 'Date of Service:', 'Date of Consultation:'])} {date_fmt(spec.collected.date(), rng.choice(['mdy', 'mdy_short', 'mon']))}", "Times-Roman", 11)
    d.ln(26)
    _, reason, paras = consult_body(rng, p.first, p.last, p.sex)
    d.put(72, f"Dear Dr. {doc_name.split()[-1]},", "Times-Roman", 11)
    d.ln(20)
    for para in paras:
        d.para(para)
        d.ln(8)
    if rng.random() < 0.35:
        d.new_page()
        d.put(72, f"{p.last}, {p.first} - page 2", "Times-Roman", 9)
        d.ln(20)
        d.para("Medications reviewed and reconciled at this visit. Allergies reviewed. Vital signs were stable. "
               "Laboratory studies from your office were reviewed in detail and are not reproduced here.")
        d.ln(8)
    d.ln(14)
    d.put(72, "Sincerely,", "Times-Roman", 11)
    d.ln(34)
    d.put(72, rng.choice(SIGNERS), "Times-Roman", 11)
    d.ln(14)
    d.put(72, s["name"], "Times-Roman", 11)
    spec.kind = "consult"
    return d, None


LAYOUTS = {
    "reference_lab": reference_lab,
    "hospital_lab": hospital_lab,
    "small_clinic": small_clinic,
    "daily_batch": daily_batch,
    "imaging": imaging,
    "consult": consult,
}


def render(spec: DocSpec, path: str, with_fax_header: bool, more: tuple[DocSpec, ...] = ()) -> tuple[int, list[dict]]:
    """
    Render one document to a PDF (cover sheet first when spec.cover). `more`: further single-patient
    reports appended to the same fax (patient k = the k-th report). Returns (page count, per-page
    truth): role "cover" or "result", owners / shown / blotted as patient indexes.
    """
    bodies = [LAYOUTS[spec.layout](spec)]
    for k, extra in enumerate(more, 1):
        bodies.append(LAYOUTS[extra.layout](extra))
        spec.abnormal_markers |= extra.abnormal_markers
    parts: list[tuple[Doc, Optional[Callable]]] = []
    meta: list[dict] = []
    if spec.cover:
        cov = cover_sheet(spec)
        _fill_pages(cov, len(cov.pages) + sum(len(b.pages) for b, _ in bodies))
        parts.append((cov, None))
        # A cover sheet's "RE:" may name the first patient (no DOB, so it never identifies anyone).
        names = [0] if spec.cover_names_patient else []
        meta += [{"role": "cover", "owners": [], "shown": [], "blotted": [], "names": names} for _ in cov.pages]
    for k, (body, footer) in enumerate(bodies):
        parts.append((body, footer))
        shift = k if more else 0  # single-patient layouts draw as patient 0
        for m in body.page_meta():
            meta.append({"role": "result", **{f: [x + shift for x in m[f]] for f in ("owners", "shown", "blotted")}, "names": []})
    return render_pdf(path, parts, spec.fax_header if with_fax_header else None), meta
