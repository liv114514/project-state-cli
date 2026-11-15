"""Create a deliberately unimportable, disposable wheel for installer rollback tests."""
from __future__ import annotations
import base64, csv, hashlib, io, re, sys, zipfile
source, destination, old, new = sys.argv[1:]
with zipfile.ZipFile(source, "r") as archive:
    entries = {name: archive.read(name) for name in archive.namelist()}
old_dir = f"project_state_python_candidate-{old}.dist-info"
new_dir = f"project_state_python_candidate-{new}.dist-info"
rewritten = {}
for name, data in entries.items():
    output_name = name.replace(old_dir, new_dir)
    if name == "project_state/__init__.py":
        data = data.replace(f'__version__ = "{old}"'.encode(), f'__version__ = "{new}"'.encode())
        data += b'\nraise RuntimeError("synthetic candidate import failure")\n'
    elif name.endswith("/METADATA"):
        data, count = re.subn(rb"(?m)^Version: " + re.escape(old.encode()) + rb"\r?$", f"Version: {new}".encode(), data)
        if count != 1:
            raise SystemExit("source wheel metadata version is ambiguous")
    if output_name.endswith("/RECORD"):
        continue
    rewritten[output_name] = data
record_name = f"{new_dir}/RECORD"
record = io.StringIO(newline="")
writer = csv.writer(record, lineterminator="\n")
for name in sorted(rewritten):
    data = rewritten[name]
    digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
    writer.writerow((name, f"sha256={digest}", len(data)))
writer.writerow((record_name, "", ""))
rewritten[record_name] = record.getvalue().encode()
with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(rewritten):
        archive.writestr(name, rewritten[name])
