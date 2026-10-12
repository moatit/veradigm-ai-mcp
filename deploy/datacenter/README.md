# Drawbridge intake in shadow mode, on MOATiT's IKI fax server

Measure Drawbridge's fax and lab intake on **real** Idaho Kidney Institute documents, inside MOATiT's data center, before anything is ever filed. The intake runs on the dedicated fax server MOATiT deploys for IKI, next to MOATiT Fax: it takes MOATiT Fax's `fax.received` webhook, the Express Lab folder and the archive of old faxes (both read-only), reads and matches every document, and records what it **would** have done. Staff keep working in Veradigm® EHR as today; Drawbridge reads back where they filed each fax and compares.

**Nothing is filed.** `INTAKE_MODE=shadow` makes filing impossible whatever `INTAKE_FILING` says, and the server only ever calls Veradigm® read actions (`SearchPatients`, `GetDocumentType`, `GetDocuments`, `GetDocumentsByDocumentType`, `GetDocumentImage`); any other action is refused before it leaves the process. No data leaves the data center: the only outbound connection is TLS to the Veradigm® Unity host, and only when live search is turned on.

## Checklist before the first real document

- [ ] **Signed BAA** covering this work (IKI ↔ MOATiT), and the owner's go-ahead in writing.
- [ ] **Named staff only.** One login per person in `users/users` (no shared accounts); the screens reachable only from IKI's and MOATiT's staff networks (`gateway.conf` `allow`/`deny`, and the server firewall).
- [ ] **Encryption at rest:** `DATA_DIR` on a dedicated LUKS volume (below). Backups encrypted too.
- [ ] Outbound checked: nothing but the Veradigm® Unity host ([Outbound](#outbound)).
- [ ] Veradigm® credentials for IKI's activation in `.env` only (mode 600), never in a ticket or chat.
- [ ] End date agreed, and who deletes everything ([At the end](#at-the-end-delete-everything)).

## What runs

```
MOATiT Fax ──fax.received (HMAC)──►┐                          ┌─► ocr (Tesseract, no network)
  (fax-link network, internal)     ├─► intake (shadow server) ─┤
Express Lab folder (read-only) ───►┤   /app/data on LUKS       └─► unity-egress ──TLS 443──► Veradigm Unity host only
Old faxes (read-only, importer) ──►┘                                (profile "veradigm")
Staff browsers ──HTTPS──► gateway (/app only)
```

| Service | Networks | Reaches |
|---|---|---|
| `intake` | `intake`, `fax-link` (both internal) | ocr, the MOATiT Fax API, Veradigm® through `unity-egress` |
| `ocr` | `intake` | nothing |
| `gateway` | `intake`, `edge` | intake (serves `/app` on the published HTTPS port) |
| `unity-egress` | `intake`, `egress` | `VERADIGM_UNITY_HOST:443`, and only when the TLS server name is that host |

`intake` runs as uid 1001 with a read-only root file system, no capabilities, and writes only to `DATA_DIR`. Logs hold item IDs, counts and error codes, never names, dates of birth, MRNs, file names or document text.

## Images

The server needs no internet to run, so build the images where npm and the package mirrors are reachable (a MOATiT build host) and copy them:

```
# build host, from the repo root (branch drawbridge/fax-intake-shadow)
docker build -f Dockerfile.unity -t drawbridge-intake:shadow .
docker build -t drawbridge-intake-ocr:shadow deploy/ocr
docker pull nginx:1.27.5-alpine
docker save drawbridge-intake:shadow drawbridge-intake-ocr:shadow nginx:1.27.5-alpine | gzip > drawbridge-shadow-images.tar.gz
# fax server
gunzip -c drawbridge-shadow-images.tar.gz | docker load
```

Copy the repo's `deploy/datacenter` folder (and `deploy/ocr`, if you build there) to the server, e.g. `/opt/drawbridge-shadow/deploy/datacenter`.

## Prepare the server

```
# 1. Encrypted volume for everything Drawbridge keeps (example: a dedicated disk /dev/sdX)
cryptsetup luksFormat /dev/sdX
cryptsetup open /dev/sdX drawbridge-shadow
mkfs.ext4 /dev/mapper/drawbridge-shadow
mkdir -p /srv/drawbridge-shadow && mount /dev/mapper/drawbridge-shadow /srv/drawbridge-shadow
# (crypttab/fstab so it opens at boot with MOATiT's key management)

# 2. Data directory, owned by the container user
mkdir -p /srv/drawbridge-shadow/data && chown -R 1001:1001 /srv/drawbridge-shadow/data && chmod 700 /srv/drawbridge-shadow/data

# 3. Settings, lists, logins, certificate (in deploy/datacenter)
cp .env.example .env && chmod 600 .env          # fill it in
mkdir -p lists users tls && chmod 750 lists users tls
cp examples/categories.example.csv lists/categories.csv   # then replace with IKI's categories
# TLS: a certificate from MOATiT's internal CA for the server's name, or self-signed:
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj "/CN=drawbridge-shadow.iki.internal" \
  -keyout tls/server.key -out tls/server.crt && chmod 600 tls/server.key
```

The Express Lab folder and the old-fax folder only need to be readable by uid 1001 (or world-readable); they are mounted read-only.

## Patient search

| | Settings | Use |
|---|---|---|
| **Live, read-only** (main path) | `UNITY_*` for IKI's activation, `VERADIGM_UNITY_HOST` = the host in `UNITY_UBIQUITY_ENDPOINT`, `COMPOSE_PROFILES=veradigm`; `INTAKE_ROSTER_CSV` unset | Same search the phone agent uses, PM + EHR. Needed for the staff filing observer. |
| **Local patient list** (early start, no Veradigm yet) | `INTAKE_ROSTER_CSV=/run/drawbridge/lists/roster.csv`, no `UNITY_*`, no profile; `INTAKE_CATEGORIES_CSV` set | Export from IKI's practice system. No outbound connection at all. |

Patient list CSV (`lists/roster.csv`, comma, semicolon, tab or `|`; header names are matched loosely, case and punctuation ignored):

| Column | Required | Header names accepted (examples) |
|---|---|---|
| Last name, first name | yes (or one "Patient Name" column as `LAST, FIRST M`) | `Last Name`, `LName`, `Surname`, `Patient Last Name`; `First Name`, `FName`, `Given Name` |
| Date of birth | yes | `DOB`, `D.O.B.`, `Date of Birth`, `Birth Date` (MM/DD/YYYY, M/D/YY, YYYY-MM-DD, YYYYMMDD) |
| MRN | yes | `MRN`, `Medical Record Number`, `Med Rec #`, `Chart Number` |
| Second MRN | no | `Patient Number`, `EHR MRN`, `Chart MRN`, `Alt MRN` |
| Chart ID | no (else the MRN is the patient key) | `Chart ID`, `EHR Patient ID` |
| Phones | no | `Home Phone`, `Cell Phone`, `Work Phone`, `Phone` |

Rows for the same patient (same key, name and DOB) are merged; rows without a usable name or DOB are skipped and counted. A missing or unreadable list is an error (the server won't start; documents fail with `ROSTER_UNAVAILABLE` and can be retried), never "no match". The list is re-read when the file changes: replace it with `cp new.csv lists/roster.csv.tmp && mv lists/roster.csv.tmp lists/roster.csv`. `examples/roster.example.csv` shows the format (made-up people).

Categories: live `GetDocumentType` when Veradigm® is reachable; otherwise `lists/categories.csv`, one category per line exactly as IKI's Veradigm® EHR shows it, including `(ready for indexing)`.

## MOATiT Fax

The intake and the MOATiT Fax API talk over the internal `drawbridge-fax-link` network (created by this compose file). In MOATiT Fax's compose file, attach its API service:

```yaml
services:
  api:                      # MOATiT Fax's API service
    networks: [default, drawbridge-fax-link]
networks:
  drawbridge-fax-link:
    external: true
```

Then, in MOATiT Fax, add a webhook for IKI's numbers: URL `http://drawbridge-intake:3001/webhooks/moatit-fax`, event `fax.received`, secret = `MOATIT_FAX_WEBHOOK_SECRET`; and create an API key with `fax:read` only for `MOATIT_FAX_API_KEY`. `MOATIT_FAX_BASE_URL` is the API service's name and port on that network. Start this stack first (it creates the network), then restart MOATiT Fax's API service.

If MOATiT Fax ever runs on another host, don't open general outbound access: publish the webhook through the gateway (add a `location = /webhooks/moatit-fax` to `gateway.conf`) and add a second forwarder like `unity-egress` for the API host.

## Start and check

```
cd /opt/drawbridge-shadow/deploy/datacenter
docker compose up -d
docker compose ps                              # all healthy
docker compose exec intake node -e "fetch('http://127.0.0.1:3001/health').then(r=>r.json()).then(console.log)"
#   { mode: 'shadow', filing: 'impossible', patient_search: 'veradigm read-only' }
docker compose logs -f intake                  # counts and codes only
```

Staff open `https://<server>:8443/app/intake`. Express Lab files are taken in within a minute of landing (each file once, never moved); set `INTAKE_BATCH_SENDERS` to the lab's name as it prints on the reports so batch files are split by patient.

## Staff logins

One line per person in `users/users`; nobody else can sign in (the shared `DRAWBRIDGE_USERNAME` login is off when this file is set):

```
read -rs -p "Password for pat.reviewer: " P; echo
printf '%s\n' "$P" | docker compose run --rm --no-deps -T intake node dist/scripts/staff-user.js pat.reviewer >> users/users; unset P
```

Passwords are stored as scrypt hashes. To remove someone, delete their line: they are signed out at once. Set `DRAWBRIDGE_SESSION_SECRET` (`openssl rand -hex 32`) so sessions survive restarts.

## Old faxes

```
docker compose exec intake node dist/scripts/intake-import.js --dir /mnt/old-faxes --dry-run     # count first
docker compose exec -d intake node dist/scripts/intake-import.js --dir /mnt/old-faxes --rate 20 --max-pending 50
```

PDF and TIFF files (also PNG/JPEG) in every subfolder are checked by content and copied, 20 a minute, into the intake inbox; the importer waits whenever 50 documents are not yet read, so OCR keeps up. Duplicates (same bytes) are skipped, including on a re-run, which continues where it stopped. The originals are only read. Old faxes have no live queue entry, so their ground truth comes from the chart search and the Confirm panel (below).

## Ground truth

1. **Staff filing observer** (live search only; `INTAKE_OBSERVE=on`). Every 30 minutes Drawbridge lists Veradigm® EHR's "(ready for indexing)" queue (`GetDocumentsByDocumentType`, all patients, last 14 days), remembers each DocumentID, and links it to the intake item for the same fax (arrival time, page count, sender; on a tie it fetches the queue document with `GetDocumentImage` and compares it with the original). When that DocumentID later shows a patient and another category, that is where staff filed it: recorded on the item as the answer, with a confidence. Faxes that never passed through the queue are looked for in the candidates' charts (`GetDocuments`) by date and page count. Not found within `INTAKE_OBSERVE_MAX_DAYS` (7) = **not observed**: never counted as correct.
2. **Confirm panel** (fallback, on each document's page): accept the prediction, search and pick the right patient and category, or mark *not an IKI patient*, *unreadable* or *several patients* with page ranges. A staff confirmation wins over an observation. The queue filters show *Needs confirmation*, *Confirmed* and *Disagrees*.

## Report

```
docker compose exec intake node dist/scripts/eval-shadow.js            # + --csv for the staff file
ls /srv/drawbridge-shadow/data/intake/reports/
```

`shadow-report-<time>.md` / `.json`: auto-file rate, precision, **wrong-patient auto-files**, category accuracy, agreement with staff filing (same patient, same category) and the disagreements to look at, reasons for staff review ranked, by sender, by fax quality, by origin, and the busiest sender layouts (template candidates). Counts and percentages only; it is checked against every name, DOB and MRN in the store before it is written, so it can be shared. The exit code is 1 when any wrong-patient auto-file was found.

`--csv` also writes `shadow-documents-<time>.csv`, one row per document **with patient identifiers** (first line says so). It stays in the data directory, for named staff only; never email or copy it out.

## Outbound

| From | To | When |
|---|---|---|
| `intake`, `ocr` | nothing outside the stack (internal networks) | always |
| `intake` | the MOATiT Fax API (internal `fax-link`) | always |
| `unity-egress` | `VERADIGM_UNITY_HOST:443`, TLS server name must equal it | profile `veradigm` |
| `gateway` | nothing (answers staff browsers) | always |

Check after start:

```
docker compose exec intake node -e "fetch('https://example.com').then(()=>console.log('OPEN')).catch(()=>console.log('blocked'))"     # blocked
docker compose exec intake node -e "fetch('https://'+process.env.VERADIGM_UNITY_HOST+'/').then(r=>console.log('veradigm',r.status)).catch(e=>console.log('veradigm down',e.cause?.code))"
```

Recommended on the host as well (Docker's `DOCKER-USER` chain; subnets from `docker-compose.yml`, `<resolver>` = the data center's DNS):

```
iptables -I DOCKER-USER -s 172.30.58.0/24 -m conntrack --ctstate NEW -j DROP                  # edge: answers only
iptables -I DOCKER-USER -s 172.30.59.0/24 -m conntrack --ctstate NEW -j DROP                  # egress: nothing ...
iptables -I DOCKER-USER -s 172.30.59.0/24 -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT   # ... but HTTPS
iptables -I DOCKER-USER -s 172.30.59.0/24 -d <resolver> -p udp --dport 53 -j ACCEPT          # ... and DNS
```

(`unity-egress` already refuses every TLS server name but the Unity host; pin the rule to Veradigm's addresses if they are stable.)

## Backups

`DATA_DIR` holds PHI (copies of the documents, items, reports). Back it up only to MOATiT storage inside the data center, encrypted, e.g. nightly with restic to an internal repository:

```
restic -r sftp:backup@backup.internal:/drawbridge-shadow backup /srv/drawbridge-shadow/data /opt/drawbridge-shadow/deploy/datacenter/{.env,users,lists}
restic -r sftp:backup@backup.internal:/drawbridge-shadow forget --keep-daily 14 --prune
```

Writes to `items.json` are atomic, so a live backup is consistent. Test a restore once. Keep backups no longer than the shadow period.

## At the end: delete everything

```
docker compose down --volumes                    # stops and removes containers and networks
rm -rf /srv/drawbridge-shadow/data               # then destroy the key:
umount /srv/drawbridge-shadow && cryptsetup luksErase /dev/sdX && cryptsetup close drawbridge-shadow
rm -rf lists users tls .env                      # patient list, logins, certificate, credentials
docker image rm drawbridge-intake:shadow drawbridge-intake-ocr:shadow
restic -r ... forget --keep-last 0 --prune       # or delete the backup repository
```

Also: remove the MOATiT Fax webhook and its API key, take the service off `drawbridge-fax-link`, ask IKI to retire or rotate the Veradigm® credentials used, and write down who deleted what and when. Keep only the shadow reports (`.md`/`.json`, no PHI).

## Settings

| Variable | Default | |
|---|---|---|
| `INTAKE_MODE` | `shadow` (fixed in the compose file) | Filing impossible; read-only Veradigm® |
| `INTAKE_ROSTER_CSV` | unset | Local patient list instead of the live search |
| `INTAKE_CATEGORIES_CSV` | unset | Category list when `GetDocumentType` isn't available |
| `INTAKE_WATCH_DIRS` / `INTAKE_WATCH_SINCE` / `INTAKE_WATCH_MAX` | `/mnt/express-lab` / none / 200 | Folders read in place; files older than the day ignored; files per scan |
| `INTAKE_OBSERVE` | `on` (off without Veradigm) | Staff filing observer |
| `INTAKE_OBSERVE_QUEUE_TYPE` | `-1000999` | "(ready for indexing)" type ID or name |
| `INTAKE_OBSERVE_EVERY_MIN` / `_WINDOW_DAYS` / `_LINK_HOURS` / `_DELAY_HOURS` / `_MAX_DAYS` | 30 / 14 / 36 / 24 / 7 | Run interval; listing window; max time between queue and receipt; chart search after; give up after |
| `INTAKE_OBSERVE_TYPES` | the categories Drawbridge suggested | Categories listed when re-checking a document that left the queue |
| `INTAKE_OBSERVE_FETCH` | `on` | Fetch queue images to break ties |
| `INTAKE_EHR_TIMEZONE` | `CLINIC_TIMEZONE` | Zone of the queue's SortDate |
| `DRAWBRIDGE_USERS_FILE` | `/run/drawbridge/users/users` | Named staff logins |

Everything else is as in `src/platform/modules/intake/README.md`.
