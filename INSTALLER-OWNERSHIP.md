# Windows installer ownership and lifecycle

## Ownership split

| Object | Owner | Install/upgrade behavior | Uninstall behavior |
|---|---|---|---|
| User-provided Python | user | inspected only when explicitly supplied to the historical prototype; never registered or modified by the new wrapper | always preserved |
| Managed CPython runtime directory | runtime bootstrap, bound by `runtime-owner.json`, uv/build identity, directory identity and file tree digest | created in a unique staging directory, verified, then published with a same-volume no-replace directory move; an existing unknown directory is refused | retained by ordinary product uninstall; no automatic runtime deletion is implemented |
| Product versions and command shim | installer transaction protocol and install receipt | new version staged in a parallel version directory; shim points through the active-version record after verification | only recorded installer-owned versions and the verified shim enter the retirement protocol |
| Project files and private state | user/project-state | never moved into the installation root | preserved |
| Installer transaction journal/quarantine | installer transaction protocol | separate from project restore journals; unresolved records gate further installer writes | retained for inspection/recovery according to the transaction protocol |

Runtime and product roots must be distinct and non-nested. Neither script edits global PATH, system Python selection, ACLs, or system configuration. The current shell can invoke the printed absolute command; user PATH integration is not implemented.

## Runtime preparation

Installer transaction protocol 0.3.5 adds durable runtime-stage ownership. Before extraction, it creates an owner receipt and an exclusive same-level lease bound to the stage and intended final runtime. A later process may inspect a clearly owned incomplete stage without trusting or publishing its extracted contents. It must refuse publication. The installer can prepare a fresh stage while retaining the incomplete one, or verify and publish a complete stage after rechecking the pinned runtime tree and identities. It does not adopt or automatically delete incomplete stages; these remain disk-consuming evidence for manual review. Missing or changed owner/lease evidence is refused. The hardlink-specific refusal case is not validated in this host: Windows returned Win32 error 5 while creating the synthetic hardlink before invoking the product path.

The current bootstrap pin is CPython 3.12.13 x64, uv 0.13.7, and the python-build-standalone 20260807 Windows distribution. The pinned uv executable is SHA-256 `1791d7a9ed5b6df13ccf80f102e025c333010d96326b4ff0262aa3b578835c5a`. uv's embedded Python download metadata selects the exact build URL and verifies the downloaded archive; the bootstrap also requires that URL to match the reviewed constant. The installed runtime is checked for Python and SQLite versions, executable digest, path type/link constraints, directory identity, and an exact-tree digest.

The build is provided by Astral's python-build-standalone rather than an official python.org installer. The downloaded runtime is not claimed to be a CPython-signed official installer. The runtime was acquired through the hash-pinned uv binary and uv's embedded distribution checksum metadata. A future distributable should include an independently reviewed runtime lock/signature policy.

For a repeatable offline first install, callers may pass an existing plain directory with `-PythonCacheRoot` and use `-OfflineRuntime`. The cache must be separate from the product install and managed runtime roots. The wrapper binds that explicit directory into the child process only; it clears ambient uv cache/offline variables. The pinned uv binary uses its embedded runtime metadata to validate the selected distribution, while `--offline` disables network access. Missing or unusable cached runtime data returns `ERUNTIME_OFFLINE_CACHE_REQUIRED` or `ERUNTIME_OFFLINE_CACHE_UNAVAILABLE` and does not silently retry online. Cache content is not deleted by uninstall. Without an explicit cache root, the prior `--no-cache` online behavior is retained.

## Lifecycle evidence and remaining gaps

The earlier isolated local trial verified: runtime preparation, installed tree inspection, a36 install → a47 upgrade, program rollback to a36, status, and uninstall. The a48 synthetic lifecycle verified fresh runtime preparation and a48 installation, installed command use, a47 → a48 upgrade, rollback to a47, status, and uninstall; the managed runtime and project marker were preserved. The a49 offline-cache gate passed 4/4: cached runtime prepare, fresh offline wrapper install of the exact a49 wheel, installed command version, and safe refusal for an empty cache and missing cache path. A later fresh installed-entry journey passed 12/12 in the current non-elevated Windows session. The 0.3.5 runtime-stage suite passed 15 cases with zero failures and one hardlink case blocked before product invocation by Win32 error 5. These results bind only the tested wheel, uv build, paths, and host; they are local and synthetic and do not imply a hosted or independent-user trial. Incomplete stages remain preserved and are not automatically adopted or deleted. PowerShell 5.1 support is not claimed. The installer prototype requires PowerShell 7+. Detailed logs are in the accompanying candidate evidence package, not this source repository.

Normal uninstall intentionally does not remove the managed Python runtime. That avoids deleting a shared or still-used interpreter. A future explicit runtime retirement action must verify its owner receipt, identity, absence of active installations, and exclusive ownership before retirement.
