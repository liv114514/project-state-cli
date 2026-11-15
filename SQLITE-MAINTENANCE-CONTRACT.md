# SQLite maintenance-window adapter contract (design only)

This contract does not enable restoring an existing database in the product.
The current candidate supports creating a verified copy at a missing target;
overwriting an existing target remains refused until an application-specific
maintenance adapter is reviewed and implemented.

## Required adapter phases

1. `enter_maintenance(context) -> MaintenanceLease`: stop new writes and
   background writers. The lease records the application identity, adapter
   version, and a bounded deadline.
2. `verify_quiescent(lease) -> QuiescenceProof`: prove that application-owned
   writers and connections are drained. A missing `-wal`/`-shm` file is not
   proof that no connection is active.
3. `capture_current(lease, destination) -> DatabaseProof`: use SQLite's
   online backup API into access-controlled private staging, then verify schema, integrity,
   byte size, and digest from that backup.
4. `prepare_target(lease, verified_source, destination) -> DatabaseProof`:
   validate the selected snapshot artifact and stage it privately. Snapshot
   SQL is inert metadata and is never executed.
5. `publish_missing_target(lease, staged, target) -> PublicationProof`:
   only publish when the database and sidecars are absent. Existing targets,
   sidecars, ambiguous ownership, unsupported lock states, and changed target
   identities are rejected.
6. `verify_application(lease, target) -> ApplicationProof`: ask the adapter
   to perform only its declared, read-only startup-health check while the
   service remains fenced.
7. Commit the operation journal only after file and application proofs match;
   then `leave_maintenance(lease)` and verify the service is accepting work.

## Failure protocol

On any failure, keep maintenance active, preserve the original private backup,
journal, and pins, and compensate only objects whose publication identity is
still proven. Verify the resulting database with `integrity_check` and the
adapter's declared read-only check before releasing the lease. If proof is
ambiguous, leave the service fenced and return a manual-resolution status.
The adapter must not run snapshot-provided SQL, arbitrary project scripts, or
shell commands. Commands are trusted adapter-owned argument arrays with a
bounded timeout and captured exit status.

## First-adapter decision

No application-specific adapter is selected. The synthetic
`sqlite-maintenance-mechanism.py` fixture has one SQLite connection and proves
only that Python's online backup API captures committed WAL data while
excluding an open uncommitted transaction. It has no application maintenance
fence, background-worker drain, service stop/resume contract, or application
health check. The project-state tool itself cannot supply those
application-owned guarantees. No authorized disposable third-party application
was available in this phase, and unrelated user directories were not searched.
Therefore the contract remains design-only, existing-database overwrite stays
disabled, and product-level maintenance-window recovery is not supported.
