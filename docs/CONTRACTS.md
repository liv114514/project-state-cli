# project-state contract revision 20 (snapshot schema v2)

Status: current implementation contract for snapshot and restore behavior. Code changes that alter fields or
semantics require a versioned edit here and notice to every consumer before
they are merged. Public snapshot schema remains v2. Revision 9 makes verified
restore cleanup intent durable before deleting pins or staging files, records
completion after each action, protects generations referenced by pending cleanup
even after a pin unlink, reconciles exact interrupted snapshot journal temps, and permits `recover --cleanup` to claim only the
exact dead local operation lock for that terminal journal. Revision 10 records
the current fail-closed limitation for an orphan prune journal temp: it blocks
generation-protection scans and subsequent prune, and the tool does not infer
whether retirement committed. Preserve the temp, operations directory, and
snapshot generations for manual diagnosis. Revision 8 adds durable Git
intent, exact interrupted-journal temporary reconciliation, and a retry command
for verified restore cleanup. Revision 7 records compare/list/restore disclosure.
Revision 6 records private
restore staging identities, compensation from the verifying phase, terminal
cleanup-pending behavior, and the compare/list disclosure rules below. Revision
6 records private staging and interrupted compensation. Revision 5 specifies a CMD-safe encoded
PowerShell rollback form, absolute system PowerShell launcher, and native
exit-code propagation; revision 4 introduced
shell-executable rollback command output; revision 3 added interrupted
snapshot-operation recovery to strict layer schemas and interrupted restore
recovery. It is not a promise of cross-platform crash or power-loss durability.

Revision 12 defines attached/detached Git restore behavior and reports the
verified final HEAD mode. A saved attached branch is reattached only when its
ref still points to the saved commit; if the ref moved or is absent, restore
uses detached HEAD at the saved commit. A saved detached snapshot remains
detached. No branch ref is moved. Revision 11 adds restricted file-layer restore selection without changing the
public snapshot schema. `restore <name> --only config,deps,runtime` accepts a
unique comma-separated subset of exactly those three names. It does not switch
Git, restore databases, Docker state, or accept arbitrary target paths. Git
must still be successfully inspected and clean; config targets tracked by the
current HEAD are refused. `deps` is indivisible and currently requires a
validated `package.json` plus a consistent `package-lock.json`; other or
missing lockfile forms are refused for selective dependency restore. All
required artifacts in the generation are validated before selection, so a
damaged unselected required artifact also refuses the request. Dry-run lists
only selected targets and records that Git/database state is unchanged. A real
operation creates a private safety point for the exact selected targets,
verifies selected bytes and proves non-selected restorable targets plus Git
HEAD/attachment/refs/index unchanged. Application health remains untested.
The API is `restoreInternal(root,name,{onlyLayers:['config','deps']})`; its
result includes `selection:{mode:'only',layers,targets}` and
`healthStatus:'not-tested'`. Without `onlyLayers`, the existing full supported
restore behavior remains in effect. Selective restore cannot be combined with
`--rollback-of`; the generated rollback command remains the sole rollback
path and resolves the exact private safety generation through the operation
journal.

## Revision 15: shared claim takeover and resolver identity

Interrupted-operation claims use claim schema version 2. A claim binds the
canonical storage root, host, owner process, original target `operationId`,
original lock token and digest (or an explicit null pair for the supported
no-original-lock cleanup/snapshot branches), exact journal digest, resolver
`operationId`, and the no-original-lock permission. The original operation ID
is the recovery target; the resolver ID is the new operation-lock owner and
resolver journal ID. A resolver journal must name the exact original ID with
`resolvesOperationId`. Existing resolver journals are validated and never
overwritten by a retry of the original operation.

Claim takeover retires an observed dead claim by atomically renaming it to the
deterministic `.retired-<old-token>` fence. A contender may proceed only after
it verifies the retired directory identity and exact owner bytes, then
publishes its new claim. A stale observer cannot remove or rename a later
winner's claim at the fixed active path. Claim release uses the same
identity-bound rename and leaves the small retired owner record in place as
a fence. These retired claim records are metadata and are not automatically
pruned. This deliberately trades bounded metadata growth for protection
against stale observers; operators must preserve them during manual recovery.

Stale-claim takeover also creates the exclusive, persistent
`operation.claim.takeover-<old-token>` directory before moving the observed
claim. Its `owner.json` binds root/host/PID, target and resolver IDs, old token,
old owner digest, and journal digest. The directory is not removed. A second
observer of that old claim receives a conflict even if it already read the old
owner. If a process dies while creating or using this arbitration record, an
incomplete or ambiguous record fails closed and requires manual resolution;
the protocol does not infer authority from age or a dead PID alone.

Before publishing an operation-lock owner, and before releasing a claim, the
process revalidates the active claim's directory identity, exact owner bytes,
token, root, host, PID, target operation ID, resolver ID, and phase. Snapshot
and restore cleanup may use the explicitly bound no-original-lock branch only
when the inspected journal proves the supported recovery intent, its exact
safety generation and pins validate, and no operation lock has appeared.
Missing lock evidence alone never authorizes claim deletion. Prune recovery
still requires its exact old lock and cannot use the no-lock branch.

Interrupted schema-version-1 claims are not migrated or removed automatically.
They remain preserved and fail closed for manual review. This protocol is
tested with independent process termination on local Windows; it does not
establish power-loss durability, behavior on other filesystems/OSes, or
cryptographic authenticity. Claim token digests provide consistency checks,
not authentication.

## Revision 16: no-original-lock provenance across resolver publication

`allowMissingOriginalLock` records whether the operation lock was absent when
the claim was created. It is immutable provenance and must not be recomputed
from current lock presence. A recovery process may publish a new
`operation.lock/owner.json` while that claim is active; after interruption,
the next process accepts the branch only by validating the current owner's
`claimToken` against the exact active or retained claim owner, then matching
root, host, operation, target operation ID, resolver operation ID, and both
original-lock identity fields. The new owner must name that exact claim and
target. A missing original token/digest pair is valid only when the claim's
historical flag is true. The current journal still must match the active
claim's recorded digest before takeover.

This historical branch remains limited to a verified restore cleanup retry
or a snapshot interrupted after the recovery path established a genuinely
absent original lock. A normal interrupted restore compensation still
requires its exact original operation-lock owner. A foreign, malformed,
active, changed, unlinked, or inconsistently bound current owner/claim/journal
is preserved and refused. A released claim can be consulted only through its
exact retained token-named record; absence of an active claim or lock by itself
is never authority. Child-process termination tests on local Windows do not
establish power-loss durability.

## Revision 14: Git preflight and interrupted lock claims

Before any `git status` call, restore enumerates both the current HEAD tree and
every NUL-delimited index entry, rejects unsupported index modes, and checks
effective attributes for all those paths in the live view and the saved/current
trees. A literal `filter=unset` or `filter=unspecified` is refused when any
matching `clean`, `smudge`, or `process` driver is configured. These checks are
execution-boundary controls, not authentication of repository content.

Interrupted-operation claim owners bind the canonical root, host, PID, target
operation id, original lock token and exact owner digest, plus the exact journal
or journal-temp digest. Recovery re-inspects these values before taking over.
Lock-owner publication atomically replaces the owner file in the existing lock
directory, avoiding a missing-lock interval. A dead complete claim is reusable
only when the lock still matches its original owner or the claim-token-bound
replacement. Malformed, missing, changed, foreign or active evidence is
retained and refused. Claim release first atomically moves the complete claim
directory to a non-blocking `.released-*` name; cleanup may be interrupted
without leaving an ownerless blocking claim. The token digest is an integrity
consistency check, not cryptographic authentication. Process-kill tests cover
the named windows; power-loss durability is not claimed.

## Compare, list and restore output

- Dependency compare reads only validated `package.json` and supported lockfile
  artifacts. It detects dependency declaration changes by an internal digest
  and does not print requested ranges or source values. For npm
  `package-lock.json`, root declarations are checked for mismatch; unsupported
  formats, missing artifacts and parse failures are `not compared`.
- Runtime pin values are not printed. Comparisons may report present, changed,
  same, or unknown from validated file bytes.
- `list` reports each layer as collected or skipped and counts validated
  restorable, record-only and private artifacts. These counts do not establish
  completeness of project state or application health.
- Restore success identifies the file-artifact targets that were applied and
  verified. Git state verification is reported separately. The output asks the
  user to run project-specific validation manually; it never implies that the
  application is healthy.

## Snapshot identity and artifacts

Each completed public and private generation is immutable and has the same
32-lowercase-hex `generation`. A snapshot name points to one generation via an
atomically replaced `current.json` file. Public and private data are separate:

```
.project-state/snapshots/<name>/current.json
.project-state/snapshots/<name>/generations/<generation>/manifest.json
.project-state/snapshots/<name>/generations/<generation>/files/...
.project-state/secrets/<name>/generations/<generation>/manifest.json
.project-state/secrets/<name>/generations/<generation>/files/...
.project-state/staging/<operationId>/{public,private}/...
.project-state/staging/<operationId>/private/restore-<random>.tmp
.project-state/operations/<operationId>.json
.project-state/pins/<name>/<generation>/<pinId>.json
```

Both manifests use these identity fields: `schemaVersion: 2`, `state:
"complete"`, `generation`, `kind` (`named|auto|hook`), `name`, `createdAt`
(valid UTC ISO timestamp), `toolVersion`, `host`, `layers`, and `artifacts`.
The public manifest lists public artifacts only. The private manifest lists
private artifacts only and repeats the identity fields. Database metadata,
schema, SQL, database bytes, raw source/config backups, and rollback copies are
private. Private hashes and sizes live only in the private manifest. Neither
manifest contains absolute source paths, secret values, SQL text, or hashes of
low-entropy private data in the public tree/log.

An artifact is exactly:

```json
{"id":"layer:runtime","layer":"runtime","kind":"layer-json",
 "privacy":"public","required":true,"path":"runtime.json",
 "sha256":"<64 lowercase hex>","size":41}
```

`artifact.path` is relative to that generation's `files/` directory for both
public and private manifests; its absolute location is
`<generation>/files/<artifact.path>`. Private raw bytes use `privacy:"private"`
and a code-owned `target`. `kind` is allowlisted by layer. Permitted restore
policies are `record-only`, `restore-file`, and `sqlite-create-missing`; SQL,
schema text, row counts, and fingerprints are record-only. An absent-path marker
is private rollback metadata `{kind:"absent",path:null,sha256:null,size:0,
target:"<allowlisted relative target>"}` and is never a normal snapshot input.
Every artifact has a unique id and case-insensitive unique `(privacy,path)`.
Size, SHA-256, layer schema, target allowlist, and recursive on-disk tree
membership are verified before restore. Unknown schema, kind, layer, required
artifact, extra file, link/reparse point, hardlink, unsafe path, or digest
mismatch invalidates the generation. Hashes detect accidental modification;
they do not authenticate a snapshot author.

Valid examples include the runtime artifact above and a private SQLite backup
with `kind:"sqlite-backup"`, `layer:"database"`,
`restore:"sqlite-create-missing"`, and target `app.db`. Invalid examples include
`../x`, `.git/config`, `C:\\x`, `foo:stream`, `NUL`, a public database backup,
public SQL/schema, an undeclared tree file, or `schemaVersion:99`.

## Storage and snapshot APIs (`lib/storage.js`, `lib/snapshot.js`)

- `storage.acquireOperationLock(root,{operation,operationId?})` resolves to
  `{root,operation,operationId,token,release()}`. Lock reuse is permitted only
  by passing the authentic live handle returned for the same canonical root.
  A foreign, forged, released, or stale lock fails closed (`ELOCK_OWNER` or
  `ELOCKED`); stale locks are not auto-deleted. This serializes project-state
  operations only, not other processes or SQLite writers.
- `storage.validateSnapshot(root,name,{mode:'restore'|'diagnostic'})` is
  read-only and resolves the current public/private generations into
  `{manifest,layers,artifacts,paths,generation,restorable,warnings}`. Artifacts
  include `absolutePath` only after path validation. Restore mode requires all
  required public and private inputs. Typed errors include `ESNAPSHOT_MISSING`,
  `ELEGACY_RESTORE`, `ESCHEMA_UNSUPPORTED`, `EMANIFEST_INVALID`,
  `EARTIFACT_MISSING`, `EARTIFACT_INTEGRITY`, `EARTIFACT_UNDECLARED`, and
  `EUNSAFE_PATH`.
- `snapshot.snapshotInternal(root,name,{lock?,kind='named',overwrite=false,
  withSeed=false,extraArtifacts=[]})` returns
  `{manifest,layers,artifacts,paths,generation,committed:true,cleanupPending}`.
  `extraArtifacts` is accepted only for `kind:'auto'` and contains private
  rollback `file` or `absent` records. Same-name non-overwrite fails `EEXISTS`.
  Overwrite stages and validates both generations first, publishes one current
  pointer as the commit point, then verifies the committed pair.
- `storage.writeOperationJournal(root,lock,data)` atomically records
  `operationId`, operation, phase, snapshot/generation, safety pins, applied
  targets, terminal outcome, and compensation outcome. Each `appliedTargets`
  entry records `target`, pre/post existence and SHA-256; optional
  `preSize`/`postSize` are non-negative byte counts and optional
  `postFileId:{dev,ino}` records the created file identity. New writers encode
  `pendingTarget` before each file rename with pre-state, intended digest/size,
  and staged file identity. `gitIntent` is exactly
  `{preGit,expectedGit,targets}` and is journaled before checkout; an
  interrupted restore accepts only the exact pre-state or expected checkout
  state, with dirty paths limited to the declared restore targets. The file itself is created below the private
  `.project-state/staging/<operationId>/private/` directory, on the same
  filesystem as the target. `pendingTemp` records exactly `{path,target,dev,ino,
  size,sha256,phase}`; it is validated against the operation id and path, then
  checked against the actual file identity and bytes during recovery. The
  `prepared` record is durable before rename; `published` is written after
  rename; then `appliedTargets` is persisted and both pending records are
  cleared. A process killed between rename and completion logging can be
  compensated only if the target bytes, size, and staged identity match.
  Staged data is retained when identity or target state is ambiguous.
  `dev` and `ino` as exact non-negative decimal strings because Windows file
  identifiers may exceed JavaScript's safe integer range; readers also accept
  legacy non-negative safe-integer numbers. Rollback proof
  requires the recorded post-size and file identity when present, in addition
  to exact bytes, so a same-byte external replacement is detectable. It never stores raw
  private values or private hashes in public logs. Malformed journals preserve
  referenced generations and make cleanup fail closed.
- A lock owner records canonical root, operation id, PID, host, and a random token. `inspectInterruptedRestore(root,id)` validates the dead local process, in-progress journal, safety generation, and exact `rollback-needed` pin. It returns `{owner,journal,safety,lockDir,ownerFile,alive}` without mutation. `claimInterruptedRestore(root,id)` returns `{lock,journal,safety}` after it rechecks owner bytes before moving the stale lock aside and acquiring a new authenticated lock.
- Snapshot commits use `inspectInterruptedSnapshot(root,id) -> {owner,journal,transaction,currentGeneration,alive,action}`; it is read-only and validates exact `operation:'snapshot'` ownership, the in-progress journal, generation pair, and pointer state. `claimInterruptedSnapshot(root,id) -> {lock,journal,transaction}` rechecks owner bytes and journal before moving only that dead lock aside and acquiring an authenticated lock for the same operation id. `recoverSnapshotTransactions(root,lock,operationId?) -> [{operationId,action,generation}]` resolves only the named transaction when `operationId` is supplied by the CLI. Without it, it may converge only the snapshot transaction owned by the authenticated lock; it scans operation journals first and refuses with `ELOCKED` if any other unresolved snapshot transaction exists, directing the caller to inspect and explicitly recover that operation ID. It never writes a foreign operation journal. A valid published generation is verified and marked committed; an unchanged prior pointer (or previously absent pointer) is recorded as safely not published. It may restore a missing pointer only to the exact validated prior generation recorded by that journal. It never deletes generation or staging data. Any pointer or generation state outside those proofs is refused and retained for manual resolution (`ELOCKED`, `ELOCK_OWNER`, `EJOURNAL_INVALID`, or `EFAILED_ROLLBACK_INCOMPLETE`).
- Active, foreign-host, malformed, or mismatched locks are never removed. CLI `recover <id> --inspect` is read-only for either operation and reports any private staged temp; `recover <id> --compensate --yes` compensates restore operations in `applying` or `verifying` when all actual target states match durable proofs, or safely resolves a snapshot commit. `recover <id> --cleanup --yes` first persists the full cleanup action list in the verified terminal journal, then executes actions one at a time and journals each completed action. If interrupted, it can claim only the exact same operation's dead local lock after validating owner identity, journal, safety generation and pin; it never removes a lock by age or PID alone. Retry is idempotent, leaves unrelated pins untouched, and retains failed/unsupported actions. `cleanupPending` is a closed array of `{kind,reason,...}` records: `release-restore-target-pin` names one exact pin; `resolve-original-safety-pin` additionally names its owning operation; `remove-private-restore-staging` names one safe relative staging path, target and exact file identity/digest. Unknown fields are rejected. A completed restore whose pin cleanup fails remains a verified business result and records `cleanupPending`; the pin and generation remain protected until retry succeeds or manual resolution is performed. Actual process termination is tested separately from thrown exceptions; power-loss durability is not claimed.

An interrupted restore or snapshot may leave exactly one sibling operation-journal temp named
`<operationId>.json.<32 hex>.tmp`. After exclusive lock takeover, recovery
validates its schema, exact operation/safety-pin identity, regular-file identity
and monotonic timestamp before promoting it over the journal. A superseded valid
temp is removed only after rechecking the current journal. Malformed, multiple,
linked, or identity-mismatched files are retained and cause refusal. This is
also applied to the exact original-operation journal when a rollback cleanup was
interrupted between writing `resolved-by-rollback` and renaming it. Snapshot
recovery validates the exact transaction identity before promoting a terminal
temp, then verifies the committed pointer and generation before reporting
`already-committed`. This is
process-interruption handling, not a power-loss guarantee.
- `storage.pinSnapshot(root,{name,generation,operationId,reason})` validates
  and persistently pins that exact immutable generation. `unpinSnapshot(root,
  {name,generation,pinId,lock,terminalOutcome})` may remove only that exact pin
  after verified completion or explicit resolution. Failed/uncertain operations
  retain pins after lock release. `listPins` and
  `isGenerationProtected(root,name,generation)` are consumed by prune. Invalid,
  pinned, or unresolved-journal generations are not prunable. Under the same
  project lock, `retireSnapshot(root,lock,{name,generation,expectedKind})` may
  retire only a fully validated `auto` or `hook` generation with no persistent
  pin or unresolved journal reference. Named snapshots are never automatically
  retired. Failure between public/private cleanup retains the generation and a
  diagnosable journal; it is not reported as fully pruned.

Snapshot operations persist a journaled `staging` intent (name, generation,
prior generation, operation id) before creating staging files or performing
project-local configuration side effects. A process stop during collection is
therefore inspectable; if the pointer is still the recorded prior generation,
recovery records that the generation was not published and retains staging
residue for manual inspection.

Commit phases are `staging -> prepared -> private-ready -> public-ready ->
publish-intent -> published -> verified -> committed`. Before pointer
publication, failure leaves the current generation unchanged. After
publication, failed verification may restore the old pointer only if it still
points to this operation's exact generation and the old generation validates.
If compensation cannot be verified, retain journal, old/new generations and
pins; return `EFAILED_ROLLBACK_INCOMPLETE`. Cleanup failure after verified
commit reports `cleanupPending` without deleting the old generation. Process
termination recovery is separately tested from thrown-exception compensation.
Power-loss durability is not claimed without filesystem-specific evidence.

## Database API (`lib/database.js`, `lib/restore-database.js`)

- Collection uses a trusted SQLite online backup API to a private temporary
  binary under `.project-state/staging/<operationId>/private/`. Schema, row counts, and `integrity_check` are read from that same
  backup. `--with-seed` explicitly permits a complete private binary artifact;
  SQL is never fed to sqlite dot-command input and is record-only.
- `planDatabaseRestore(root,validated,{operationId})` returns
  `{root,name,generation,operationId,steps:[{target,sourcePath,sourceSha256,expectedSchema,
  expectedRows,mode:'sqlite-create-missing',applied:false}],refusals:[]}`.
  It validates artifact identity, private location, hash, size, SQLite integrity,
  schema and row count. Unsupported or legacy SQL-based restore is refused.
- `preflightDatabaseRestore(root,plan)` rechecks each target and returns an
  immutable preflight token bound to the root, target absence, and artifact
  digest. An existing database, `-wal`, `-shm`, or `-journal`, lock/unsupported
  state, path alias, or concurrent change is refused without mutation.
- `applyDatabaseRestore(root,plan,token)` exclusively publishes a verified
  staged binary under the same private project staging root only to a missing target, then calls verification. It never
  replaces an existing database. `verifyDatabaseRestore(root,plan)` checks
  exact artifact bytes, schema/row metadata and `PRAGMA integrity_check`.
- `compensateDatabaseRestore(root,plan,token)` removes only a database created
  by this operation whose file identity/hash still matches and has no sidecars.
  If another process changed it or attached sidecars, compensation refuses to
  delete it and reports `rollback-incomplete` with the private safety reference.
- `planDatabaseRollback(root,safetySnapshot,{operationId,previousJournal})`
  reconstructs a later user-invoked rollback from private `rollback/absent`
  markers plus the original operation journal. It includes only databases that
  the named prior operation created, whose recorded post-bytes still match and
  whose sidecars are absent. Its own preflight/apply/verify/compensate stages
  remove only that exact operation-created file and verify absence. It refuses
  external changes and never relies on in-memory state from the earlier CLI.

Schema-only is metadata, not a database restore. A missing sqlite3 executable
is a blocked/failed database gate, never a passing skip in required mode.
Legacy v1 `db-original` is diagnostic-only: do not parse, execute, migrate,
move, or delete it automatically; restoration requires a newly collected v2
snapshot. Warn that old public paths may contain private database bytes.

### Minimal API calls

The API is internal to this package and these examples assume the caller has
already selected a trusted project root. Snapshot callers that pass a lock own
its release; `snapshotInternal` does not release a caller-owned lock:

```js
const Store = require('./lib/storage');
const { snapshotInternal } = require('./lib/snapshot');
const lock = await Store.acquireOperationLock(projectRoot, { operation: 'snapshot' });
try {
  const saved = await snapshotInternal(projectRoot, 'before-change', { lock, kind: 'named' });
  if (!saved.committed) throw new Error('snapshot was not committed');
} finally {
  await lock.release();
}
const checked = await Store.validateSnapshot(projectRoot, 'before-change', { mode: 'restore' });
```

SQLite restore planning is read-only. Apply is possible only after preflight
returns a token for a missing target; callers must verify the result and
compensate an apply failure with the same plan and token:

```js
const DB = require('./lib/restore-database');
const plan = await DB.planDatabaseRestore(projectRoot, checked, { operationId });
const token = await DB.preflightDatabaseRestore(projectRoot, plan);
try {
  await DB.applyDatabaseRestore(projectRoot, plan, token);
  await DB.verifyDatabaseRestore(projectRoot, plan);
} catch (error) {
  const result = await DB.compensateDatabaseRestore(projectRoot, plan, token);
  if (!result.ok) throw new Error(`database compensation needs manual resolution: ${error.message}`);
  throw error;
}
```

If the process stops, inspect first and only then request the narrow recovery
action for the printed operation ID:

```sh
project-state recover 0123456789abcdef0123456789abcdef --inspect
project-state recover 0123456789abcdef0123456789abcdef --compensate --yes
project-state recover 0123456789abcdef0123456789abcdef --cleanup --yes
```

The second command is not valid until inspection identifies a dead local owner
and the stored journal/generation/pin proof passes. Invalid examples include
calling recovery for an active/foreign lock, passing an invented lock handle,
applying a database plan without its preflight token, or treating
`schemaVersion:1` SQL as an executable database input.

## Restore result, journal and exit semantics

`lib/restore.js` produces a result with `status` in
`refused|restored-verified|failed-rolled-back|failed-rollback-incomplete`,
operation id, source snapshot generation, applied/verified steps, final Git
state, and persistent safety pin references. After a verified Git restore,
`gitAttachment` is `{mode:'attached',ref:'refs/heads/<name>'}` or
`{mode:'detached',ref:null}`; a non-Git project reports
`{mode:'not-a-git-repository',ref:null}`. CLI output states the same verified
mode. It does not claim application health. A refusal occurs before business
mutation and returns CLI exit 1. A
verified restore returns 0. An execution failure returns 2; if compensation is
incomplete, the message names the retained pin and actual observed state.
Journal phases are `preflight`, `safety-point`, `applying`, `verifying`,
`completed`, `compensating`, `failed-rolled-back`, or
`failed-rollback-incomplete`. Logs contain paths only where needed and no
secret content or low-entropy private digests. Hook-owned logging failure is
nonblocking; foreign hook failure remains the original nonzero exit.

The success message prints an executable rollback command with the safety
snapshot and `--rollback-of <operationId>`. On Windows it prints the exact
PowerShell invocation first and a Command Prompt equivalent that invokes the
system PowerShell executable by absolute `SystemRoot` path and runs the same
script through `-EncodedCommand` (UTF-16LE Base64), so CMD never parses CLI
installation paths containing `%` or `!`. The script exits with the Node
CLI's status so CMD callers can observe a refused or failed rollback. On POSIX it prints a
POSIX-shell invocation. Commands use the running Node executable and the
absolute CLI script path so source-checkout invocation does not depend on an
installed `project-state` shim. The command must be run from the same project
root where the restore completed. This narrow mode is not equivalent
to `--force`: it requires the matching unresolved operation journal, verifies
that every current dirty path is one created by that operation and still has
the recorded post-restore bytes/existence, verifies HEAD/refs/index against the
recorded post-state, and requires no other changes. If proof does not match,
it refuses without mutation. This permits exact rollback of tool-created dirty
configuration while continuing to reject arbitrary staged, unstaged,
untracked, renamed, or externally changed work. A successful verified rollback
closes the journal and releases its persistent pin; failure keeps the pin.

Layer JSON uses closed structural schemas. Unknown keys and wrong nested types
are rejected for Git, deps, runtime, config, Docker, and database records.
Config key metadata contains only `nonEmpty`; runtime version pins contain only
`name`. This checks shape and policy, not arbitrary string content or the
trustworthiness/authenticity of a snapshot author.

## Support and refusal boundary

Git restore requires repository root, supported ordinary worktree, successful
Git probes, clean index/worktree (even with `--force`), available local commit
objects, and no unsupported filter/hook boundary. An attached snapshot is
reattached only if its recorded branch ref still points to the saved commit;
otherwise restore is detached at that commit. A snapshot recorded detached
remains detached. Branch refs are never moved. Linked worktree, submodule, sparse
checkout, dirty state, uncertain index/refs, missing objects, or unsafe external
execution path is refused. Every required file is replayed after checkout and
final bytes, HEAD attachment, refs, and index are checked.

SQLite supports collection through a real sqlite3 online-backup CLI and,
when explicitly requested, creation of a missing database from a private
binary backup. Existing databases and sidecars are never overwritten. No SQL
snapshot is executed. Other databases, active-connection exclusion, database
replacement, complete environment installation, Git object portability,
application health, cloud/team sync, and cross-platform safety are not claimed.

Snapshot kind and valid time, with stable name/generation tie-break, drive
prune; name prefixes never confer deletion authority. Invalid time and invalid
generation are retained. A valid current auto/hook generation may be retired
under the project lock only when no persistent pin or unresolved journal refers
to it; named generations are never automatically retired. v1 can be
listed/diagnosed as legacy and potentially
private; it is not restorable, automatically migrated, or automatically
deleted. `.project-state/secrets` is private local storage, not encryption.

Revision 13 adds owner-bound prune recovery without changing snapshot schema v2.
The immutable prune plan binds the original `operationId`, lock token, exact
`name+generation`, kind/time, public/private directory identities, pointer
identity and digest. Mutable progress is validated separately and can advance
only through `planned -> retiring -> committed -> retired`; completed targets
are an exact subset of the plan and cannot be removed. A same-name new
generation, altered pointer, changed owner, foreign pin, active lock, linked or
ambiguous journal evidence, or illegal progress transition is refused without
retiring data. `recover <operationId> --inspect` is read-only;
`recover <operationId> --continue --yes` claims only a verified stale local
prune lock and deterministically continues its original plan. It is idempotent.
Once the journal records business commit, subsequent cleanup failure is a
retryable cleanup state and never compensates the prune. Existing unowned or
corrupt orphan temporaries remain fail-closed; no ownership is inferred from
a filename or parseable JSON. Child-process termination tests do not establish
power-loss durability.

Revision 16 clarifies the historical meaning of
`allowMissingOriginalLock`: it records whether the original operation lock was
absent when a claim was created. A resolver lock published later does not
change that provenance. Recovery must follow the exact claim token, target and
resolver operation IDs, journal digest, and original lock token/digest (or the
explicitly permitted null pair) before accepting a resolver owner. Restore
compensation still requires the original lock proof; verified restore cleanup
and an inspected interrupted snapshot have narrow no-original-lock paths;
prune recovery continues to require its exact original operation lock. This
clarification changes no journal field or public snapshot schema.

Git restore checks effective attributes for the current tree before `git
status`, because status may invoke configured clean/process filters. It checks
the target tree again before normal checkout and checks the current tree again
before compensating checkout. An active filter or an ambiguous unset value
with a configured same-named `smudge` or `process` driver is refused before
the protected Git command. Attribute/config probes are read-only and do not
execute filter commands.

Revision 13 also clarifies restore authorization: `--yes` explicitly
authorizes writes; there is no interactive confirmation. `--dry-run` previews
the current plan and does not reserve a snapshot generation. It does not modify
business targets, but may create and release lock/pin metadata. Configuration
comparison verifies private file bytes and reports only changed/added/removed
keys, never values or private digests; absent or invalid evidence is `unknown`,
not equal.

## Revision 17: journal-transition claims and terminal cleanup lock closure

When an authenticated resolver reconciles one exact, schema-valid operation
journal temp, it first writes
`.project-state/locks/operation.claim-journal-<claimToken>.json`. The record
binds the claim token, root, host and claim-owner PID; operation, target and
resolver IDs; original-lock token/digest and no-original-lock provenance; the
prior and next journal digests; exact temp basename and digest; and the
immutable transaction identity. It is written before the atomic journal
rename. A later process may accept the changed journal digest only when this
record matches the retained claim and current journal exactly. Missing,
changed, linked, multiply linked, mismatched, or conflicting transition
evidence is preserved and refused. This is local consistency evidence, not
cryptographic authentication. The transition record is retained with claim
history and is not automatically pruned.

At revision 17, a verified restore whose cleanup journal was complete could
close a leftover dead cleanup-resolver lock only for the no-original-lock
claim origin. Revision 18 below supersedes that origin restriction with exact
validation for both supported origins. The other protections and limits
remain in force.
## Revision 18: exact original-lock terminal cleanup claims

Verified restore cleanup may resolve a completed cleanup journal after the
original restore lock has been claimed and replaced by a resolver lock. The
resolver owner is accepted only when the retained claim binds the original
operation and the resolver operation, and proves one of two exact origins:
(a) the original lock was absent when the cleanup claim was created, with a
null token/digest pair and no original-lock token on the resolver; or (b) the
original lock existed, with its valid token and owner digest preserved in the
claim and resolver. The claim's `allowMissingOriginalLock` records historical
provenance and is not recomputed from whether a lock currently exists. In both
cases the current owner must match the claim token, target operation, resolver
ID, PID, root and host; the completed journal, empty cleanup list, safety
generation and corresponding pin are revalidated under the claim before the
resolver lock is released. Mismatched, incomplete or ambiguous evidence is
retained and refused. Snapshot's narrow no-original-lock path and restore
compensation's requirement for the original lock are unchanged. This changes
no journal field or snapshot schema. Process termination is tested on the
local Windows environment; power-loss durability is not established.

## Revision 19: restore publication ownership and lock retirement

Restore file publication uses exclusive creation for an originally absent
target. For an existing target, the publisher records its expected bytes and
file identity, moves the target to operation-private staging, verifies that
identity, then publishes the staged restore inode without replacing a path
that appeared concurrently. A mismatch is preserved or returned with an
exclusive link; uncertain states retain journal and safety evidence and are
not reported as a verified rollback. Absent-marker deletion similarly records
the exact original identity before moving it to private staging, then removes
only that verified inode. Rollback of an originally absent target uses the
same identity-bound retirement rule. These checks narrow races but do not
provide a cross-platform atomic compare-and-swap against arbitrary writers;
ambiguous results fail closed.

Operation lock release atomically renames the owner-bearing lock directory to
a random token-bound retired name before best-effort cleanup. A cleanup failure
may leave an inert retired directory, but cannot leave an ownerless active lock
directory. Retired directories are not used as authority to remove a later
active lock and are not automatically aged out.

Live SQLite schema observations bind their digest and size to the exact bytes
collected in that comparison invocation. Stored snapshot schema artifacts
continue to require their already validated manifest digest; comparison does
not re-trust a damaged stored artifact by calculating a replacement digest.
Row-by-row database content comparison remains unsupported. These changes do
not alter the public snapshot schema v2.

## Revision 20: post-checkout file binding and resolver cleanup paths

When a Git checkout is part of restore, the implementation verifies the
selected HEAD, attachment, refs, index tree, and worktree status before file
artifacts are replayed. A tracked target's immediate pre-publication state is
bound to the observed post-checkout file identity; the separate pre-operation
state remains in the private safety generation for compensation. Untracked
targets must still match their pre-checkout identity. A changed or ambiguous
target is refused. This allows validated snapshot file bytes to be replayed
after a legitimate Git switch without treating checkout output as the
pre-restore rollback state.

A `remove-private-restore-staging` cleanup action may refer to the resolved
operation's staging directory only when the resolver journal explicitly binds
that `resolvesOperationId`. All paths and file identity/digest fields remain
validated; unrelated operation staging paths are invalid. The snapshot schema
remains v2.
