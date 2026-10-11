"""
Invented patient roster for the intake test bench. Every name, date of birth, MRN and phone number
is made up: names are random first/last combinations from the lists below, phones are in the
fictional 555-01xx block, MRNs are random. Nothing here comes from a real chart.

Hard cases built in (tag on each patient):
  same_name_diff_dob   two patients, same first + last name, different DOB
  duplicate            same first + last name AND DOB, different MRNs (true duplicate charts)
  soundalike           same first name, sound-alike last names (Beasley / Beesly ...)
  hyphen, apostrophe   Garcia-Lopez, O'Brien ...
  multiword            two-word last names (De La Cruz, Van Wyk)
  twin                 same last name, DOB and home phone, different first names
  household            same last name and home phone (spouses), different DOBs
The outside pool holds people who are NOT in the roster (documents for them must end as "none");
a few share a full name with a roster patient but not the DOB.
"""
from __future__ import annotations

import random
from dataclasses import asdict, dataclass, field

FIRST_F = """Abigail Ada Adele Agnes Alice Alma Amara Amelia Anita Ann Annette Aria Beatrice Bernice Bonnie
Brenda Carla Carmen Caroline Celia Clara Colleen Cora Darlene Deborah Delia Diane Dolores Donna Edith Elena
Elise Eliza Ellen Elsie Emma Esther Eva Evelyn Faith Fern Fiona Frances Gail Georgia Gloria Grace Greta
Harriet Hazel Helen Ida Imogen Irene Iris Isabel Ivy Jane Janet Jean Joan Josephine Joy Judith June Kathleen
Laura Leah Lena Leona Lillian Lois Lorraine Lucille Lydia Mabel Marcia Margaret Marian Marlene Martha
Maxine Mildred Miriam Myra Nadine Naomi Nell Nora Opal Paula Pearl Phyllis Priscilla Ramona Rhoda Rita Rosa
Ruth Sadie Selma Sylvia Tamsin Thelma Valerie Vera Viola Wanda Wilma Yolanda Zelda""".split()
FIRST_M = """Abel Alden Alvin Amos Anton Arlo Arthur August Barrett Bennett Bernard Boyd Bruce Calvin Carl
Cecil Chester Clarence Clifford Clyde Conrad Cyrus Dale Darrell Dean Delbert Desmond Dewey Dominic Donald
Douglas Duane Earl Edgar Edmund Elias Elmer Emil Ernest Eugene Everett Felix Floyd Francis Franklin Gilbert
Gordon Grady Harlan Harold Hector Herbert Homer Howard Hugh Ira Irving Ivan Jasper Jerome Jesse Julian
Kendall Lamar Lawrence Leland Leon Leroy Lester Lloyd Lowell Luther Lyle Marshall Marvin Maurice Merle
Milton Morris Murray Nelson Norman Oliver Orville Oscar Otis Percy Quentin Ralph Raymond Reuben Roland
Roscoe Royce Rufus Russell Sherman Silas Stanley Sterling Thaddeus Truman Ulysses Vernon Victor Virgil
Wallace Warren Wendell Wilbur Willis Winston""".split()
LAST = """Abernathy Ackerly Aldridge Ambrose Ashby Atwater Bancroft Barlow Beckett Bellamy Birch Blackwood
Bramwell Brightman Calloway Carver Castellano Chadwick Chandler Colfax Corliss Crandall Cullen Dalton
Delacroix Dempsey Dorsey Drummond Eastman Eldridge Ellery Emerson Fairbanks Falkner Farrow Fenwick Finch
Fitzgerald Fletcher Gallo Garrity Gaskell Gilchrist Goodwin Greer Hadley Halvorsen Hargrove Hartwell
Haskins Hawthorne Hendricks Holloway Hornby Huxley Ingram Jarrell Keane Kendrick Kessler Kimball Kingsley
Lachance Langford Larkin Lattimore Lindqvist Lockhart Lowry Lundgren Macklin Mallory Marchetti Mayhew
Merriweather Montague Moreland Nakamura Nightingale Norcross Northcutt Oakley Okafor Ostrander Pembroke
Pendleton Petrakis Pickering Prescott Quimby Radcliffe Ramsey Ravenscroft Redfield Rinaldi Rockwell
Rosenthal Rutledge Salazar Sandoval Satterfield Sinclair Slocum Stafford Stanhope Sterling Stroud
Sutherland Tanaka Tolliver Townsend Trujillo Underwood Vance Vandermeer Varga Wainwright Waverly Weatherby
Westbrook Whitaker Wilder Winslow Woodruff Yamamoto Yates Zamora Zielinski""".split()
MIDDLE = list("ABCDEFGHJKLMNPRSTW")

SOUNDALIKE = [("Beasley", "Beesly"), ("Jensen", "Jenson"), ("Petersen", "Peterson"), ("Reid", "Reed"),
              ("Schmitt", "Schmidt"), ("Thompson", "Thomson")]
HYPHEN = ["Garcia-Lopez", "Smith-Okafor", "Harper-Vane", "Nguyen-Baird", "Ortiz-Kemp"]
APOSTROPHE = ["O'Brien", "D'Angelo", "O'Neil", "D'Souza", "O'Malley"]
MULTIWORD = ["De La Cruz", "Van Wyk", "St. Clair"]

# Patients: 555-01xx in these area codes. 208-555-01xx is kept for senders and the clinic.
AREA = ["986", "541", "775", "509", "406", "435", "801", "702"]


@dataclass
class Patient:
    key: str
    patient_id: str
    chart_patient_id: str
    first: str
    middle: str
    last: str
    dob: str  # MM/DD/YYYY
    sex: str
    # Veradigm keeps two MRNs: the PM MRN and the EHR chart MRN (= PM "PatientNumber"). Outside
    # documents may carry either one.
    pm_mrn: str
    ehr_mrn: str
    home_phone: str  # 10 digits
    cell_phone: str  # 10 digits or ''
    tags: list[str] = field(default_factory=list)

    @property
    def full(self) -> str:
        return " ".join(x for x in (self.first, self.middle, self.last) if x)

    def to_json(self) -> dict:
        return asdict(self)


class Phones:
    """Unique fictional numbers: <area>-555-01xx (800 numbers)."""

    def __init__(self, rng: random.Random):
        self.pool = [f"{a}55501{n:02d}" for a in AREA for n in range(100)]
        rng.shuffle(self.pool)

    def take(self) -> str:
        return self.pool.pop()


def _dob(rng: random.Random, lo: int = 1934, hi: int = 2004) -> str:
    y = rng.randint(lo, hi)
    m = rng.randint(1, 12)
    d = rng.randint(1, 28)
    return f"{m:02d}/{d:02d}/{y}"


def _sex_first(rng: random.Random) -> tuple[str, str]:
    if rng.random() < 0.5:
        return "F", rng.choice(FIRST_F)
    return "M", rng.choice(FIRST_M)


def build_roster(n: int, rng: random.Random) -> tuple[list[Patient], list[Patient]]:
    """(roster, outside). Roster size is exactly n (n >= 80)."""
    phones = Phones(rng)
    mrns: set[str] = set()
    out: list[Patient] = []
    seen: set[tuple[str, str, str]] = set()

    def mrn() -> str:
        while True:
            v = str(rng.randint(10000, 999999))
            if v not in mrns:
                mrns.add(v)
                return v

    def add(first: str, last: str, dob: str, sex: str, tags: list[str], home: str = "", middle: str | None = None) -> Patient:
        i = len(out) + 1
        p = Patient(
            key=f"P{i:04d}",
            patient_id=str(90000 + i),
            chart_patient_id=str(70000 + i),
            first=first,
            middle=middle if middle is not None else (rng.choice(MIDDLE) if rng.random() < 0.45 else ""),
            last=last,
            dob=dob,
            sex=sex,
            pm_mrn=mrn(),
            ehr_mrn=mrn(),
            home_phone=home or phones.take(),
            cell_phone=phones.take() if rng.random() < 0.35 else "",
            tags=tags,
        )
        seen.add((first.lower(), last.lower(), dob))
        out.append(p)
        return p

    # Hard cases first.
    for _ in range(6):
        sex, first = _sex_first(rng)
        last = rng.choice(LAST)
        add(first, last, _dob(rng), sex, ["same_name_diff_dob"])
        add(first, last, _dob(rng), sex, ["same_name_diff_dob"])
    for _ in range(4):
        sex, first = _sex_first(rng)
        last = rng.choice(LAST)
        dob = _dob(rng)
        add(first, last, dob, sex, ["duplicate"], middle="")
        add(first, last, dob, sex, ["duplicate"], middle="")
    for i, (a, b) in enumerate(SOUNDALIKE):
        sex, first = _sex_first(rng)
        dob = _dob(rng)
        add(first, a, dob, sex, ["soundalike"])
        # Two pairs share the DOB too: only the spelling of the last name tells them apart.
        add(first, b, dob if i < 2 else _dob(rng), sex, ["soundalike"])
    for last in HYPHEN:
        sex, first = _sex_first(rng)
        add(first, last, _dob(rng), sex, ["hyphen"])
    for last in APOSTROPHE:
        sex, first = _sex_first(rng)
        add(first, last, _dob(rng), sex, ["apostrophe"])
    for last in MULTIWORD:
        sex, first = _sex_first(rng)
        add(first, last, _dob(rng), sex, ["multiword"])
    for pair in (("Daniel", "Danielle", "M", "F"), ("Mary", "Martha", "F", "F")):
        last = rng.choice(LAST)
        dob = _dob(rng, 1950, 1990)
        home = phones.take()
        add(pair[0], last, dob, pair[2], ["twin"], home=home)
        add(pair[1], last, dob, pair[3], ["twin"], home=home)
    for _ in range(5):
        last = rng.choice(LAST)
        home = phones.take()
        add(rng.choice(FIRST_M), last, _dob(rng, 1940, 1975), "M", ["household"], home=home)
        add(rng.choice(FIRST_F), last, _dob(rng, 1940, 1975), "F", ["household"], home=home)

    while len(out) < n:
        sex, first = _sex_first(rng)
        last = rng.choice(LAST)
        dob = _dob(rng)
        if (first.lower(), last.lower(), dob) in seen or any(p.first == first and p.last == last for p in out):
            continue
        add(first, last, dob, sex, [])

    # Shuffle keys so hard cases are not all at the top of the roster.
    rng.shuffle(out)
    for i, p in enumerate(out, 1):
        p.key, p.patient_id, p.chart_patient_id = f"P{i:04d}", str(90000 + i), str(70000 + i)

    outside: list[Patient] = []
    roster_names = [(p.first, p.last, p.sex) for p in out if not p.tags]
    for i in range(max(40, n // 6)):
        if i < 8:
            first, last, sex = roster_names[i]  # same full name as a roster patient, different DOB
            dob = _dob(rng)
            while any(p.first == first and p.last == last and p.dob == dob for p in out):
                dob = _dob(rng)
            tags = ["outside", "name_collision"]
        else:
            sex, first = _sex_first(rng)
            last = rng.choice(LAST)
            dob = _dob(rng)
            if any(p.last == last and p.dob == dob for p in out):
                continue
            tags = ["outside"]
        outside.append(Patient(
            key=f"X{i + 1:04d}", patient_id="", chart_patient_id="", first=first,
            middle=rng.choice(MIDDLE) if rng.random() < 0.4 else "", last=last, dob=dob, sex=sex,
            pm_mrn=str(rng.randint(100000, 9999999)), ehr_mrn=str(rng.randint(100000, 9999999)), home_phone=phones.take() if phones.pool else "",
            cell_phone="", tags=tags,
        ))
    return out, outside
