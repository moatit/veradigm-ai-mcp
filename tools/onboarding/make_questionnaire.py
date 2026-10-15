"""Drawbridge clinic setup questionnaire (document intake) as an .xlsx with dropdown answers.

    python tools/onboarding/make_questionnaire.py out.xlsx ["Clinic name"]

Upload to Google Drive (it converts to a Google Sheet, dropdowns included). Keep one master
template; copy it per clinic. Questions are for clinic policy only; everything MOATiT can read
from its own systems is in docs/drawbridge/CLINIC_ONBOARDING.md (internal checklist).
"""
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation

# (section, question, answer choices or None for free text, what to put in Details)
QUESTIONS = [
    ("Review", "Who should review a result after Drawbridge files it?",
     ["Ordering provider", "Nurse", "Results pool", "Other (see details)"], "Name or pool"),
    ("Review", "How are results routed today?",
     ["Task to the provider", "Task to a pool", "On paper / in person", "Not sure"], ""),
    ("Critical results", "Does the person attaching a lab result also read it for abnormal or critical values?",
     ["Yes", "Sometimes", "No"], ""),
    ("Critical results", "What counts as critical?",
     ["The lab's flags", "Our own list (please attach)", "Both"], ""),
    ("Critical results", "Who should we inform when a critical result arrives?",
     ["Ordering provider", "Nurse on duty", "A named person (see details)", "Results pool"], "Name"),
    ("Critical results", "How should we inform them?",
     ["Task", "Phone call", "Task and phone call"], ""),
    ("Always a person", "Besides critical results, which documents should always go to a person?",
     ["None", "Prior authorizations", "Records / legal requests", "Several (see details)"], "List them"),
    ("People", "Who checks the documents Drawbridge isn't sure about? (We set up their logins.)",
     ["The person who indexes today", "Front desk", "Medical records", "Other (see details)"], "Names and emails"),
    ("Categories", "Which category does your team use for lab results?",
     ["Lab Results", "Labs/Procedures", "Laboratory Report", "Other (see details)"], ""),
    ("Categories", "Are there categories we should never use?",
     ["No", "Yes (see details)"], "Which ones"),
    ("Testing", "Are there test patients in your Veradigm system we can use for the pilot?",
     ["Yes (see details)", "No", "Not sure"], "Names"),
    ("Testing", "Which documents or senders are hardest for your team today? (We'll include them in testing.)",
     None, "Senders or document types"),
    ("Testing", "Any shortcuts or exceptions your team uses when indexing?",
     ["No", "Yes (see details)"], "Describe"),
    ("Phone (later)", "Which appointments may patients book or cancel by phone?",
     ["All types", "Follow-ups only", "None, always transfer", "Other (see details)"], ""),
    ("Phone (later)", "When should a caller always be transferred to a person?",
     None, "For example new patients, urgent symptoms, billing"),
]

HOW = [
    "Identifying the patient: full name + date of birth, matching exactly one patient. When the document "
    "also shows the last 4 of the SSN or the address, we check that too. Anything that doesn't line up goes to a person.",
    "Going live: Drawbridge first runs for one week alongside your team without filing anything. We compare "
    "what it would have done with what your team did, fix the differences, then switch filing on.",
]


def build(path: str, clinic: str = "") -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Setup questions"
    navy = PatternFill("solid", fgColor="2B2A4C")
    pale = PatternFill("solid", fgColor="F3F2F8")
    answer = PatternFill("solid", fgColor="FFF7D6")
    thin = Side(style="thin", color="D0CFE0")
    box = Border(left=thin, right=thin, top=thin, bottom=thin)
    wrap = Alignment(wrap_text=True, vertical="top")

    ws["A1"] = "Drawbridge setup: faxes and lab results"
    ws["A1"].font = Font(size=16, bold=True, color="2B2A4C")
    ws["A2"] = "Clinic:"
    ws["B2"] = clinic or "(clinic name)"
    ws["A2"].font = Font(bold=True)
    ws["A3"] = "About 5 minutes. Pick an answer from the list in the yellow column; add names in Details where asked."
    ws["A3"].font = Font(italic=True, color="555555")
    ws["A5"] = "How it works"
    ws["A5"].font = Font(bold=True, color="2B2A4C")
    for i, line in enumerate(HOW):
        cell = ws.cell(row=6 + i, column=1, value="• " + line)
        ws.merge_cells(start_row=6 + i, start_column=1, end_row=6 + i, end_column=5)
        cell.alignment = wrap
        ws.row_dimensions[6 + i].height = 32

    head = 9
    for col, title in enumerate(["#", "Topic", "Question", "Answer", "Details", "What to put in Details"], start=1):
        c = ws.cell(row=head, column=col, value=title)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = navy
        c.border = box
        c.alignment = Alignment(vertical="center")

    for n, (section, question, choices, details) in enumerate(QUESTIONS, start=1):
        r = head + n
        ws.cell(row=r, column=1, value=n)
        ws.cell(row=r, column=2, value=section)
        ws.cell(row=r, column=3, value=question)
        a = ws.cell(row=r, column=4, value="")
        d = ws.cell(row=r, column=5, value="")
        a.fill = answer
        if details:
            d.value = None
            ws.cell(row=r, column=5).comment = None
        for col in range(1, 6):
            c = ws.cell(row=r, column=col)
            c.border = box
            c.alignment = wrap
            if col < 4 and n % 2 == 0:
                c.fill = pale
        if choices:
            dv = DataValidation(type="list", formula1='"' + ",".join(x.replace(",", " ") for x in choices) + '"', allow_blank=True)
            dv.prompt = "Pick one"
            dv.showDropDown = False
            ws.add_data_validation(dv)
            dv.add(a)
        else:
            a.value = None
            a.fill = PatternFill("solid", fgColor="FFFFFF")
            ws.cell(row=r, column=4).value = "(write in Details)"
            ws.cell(row=r, column=4).font = Font(italic=True, color="888888")
        if details:
            ws.cell(row=r, column=5).value = None
            ws.cell(row=r, column=5).font = Font(color="888888", italic=True)
        ws.row_dimensions[r].height = 36

    # Hint text for Details lives in a light column note under the header row of each question.
    for n, (_, _, _, details) in enumerate(QUESTIONS, start=1):
        if details:
            ws.cell(row=head + n, column=5).value = ""
            ws.cell(row=head + n, column=5).fill = answer
            ws.cell(row=head + n, column=5).number_format = "@"
            ws.cell(row=head + n, column=6, value=details).font = Font(italic=True, color="999999", size=9)

    for col, width in zip("ABCDEF", [5, 16, 58, 30, 34, 30]):
        ws.column_dimensions[col].width = width
    ws.freeze_panes = ws.cell(row=head + 1, column=1)
    end = head + len(QUESTIONS) + 2
    ws.cell(row=end, column=1, value="Thank you! Questions? Reply to the email or call MOATiT.").font = Font(italic=True, color="555555")
    wb.save(path)


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "")
