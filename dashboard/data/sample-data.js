/*
 * SYNTHETIC SAMPLE DATA — not collected from any real project.
 *
 * Shapes mirror the project-state CLI JSON contracts:
 *   - list --json            (resultSchemaVersion 2)
 *   - doctor --task ... --json (resultSchemaVersion 1)
 *   - doctor (general, text output parsed by tools/collect_data.py)
 *   - compare A [B]          (raw text output)
 *   - recover ID --inspect   (resultSchemaVersion 1)
 *   - demo                   (resultSchemaVersion 1)
 *
 * Replace with real data via tools/collect_data.py (writes data/live-data.js),
 * or drag a JSON bundle / `list --json` output onto the page.
 */
(function () {
  "use strict";

  var LAYERS = ["git", "deps", "runtime", "config", "docker", "database"];

  function hex(seed) {
    var out = "";
    var x = seed * 2654435761 % 4294967296;
    while (out.length < 32) {
      x = (x * 1103515245 + 12345) % 2147483648;
      out += (x % 16).toString(16);
    }
    return out;
  }

  var VERIFIED_LIMITATIONS = [
    "Stored input integrity does not establish restore prerequisites.",
    "Supported restore is limited to one config target and Windows-only SQLite creation at a missing target; other layers are record-only or unavailable.",
    "Application health and runtime behavior were not tested.",
    "Database row contents are not included in this inspection result."
  ];

  /** Build a verified schema-v2 snapshot record exactly like inventory._snapshot_record. */
  function verified(name, seed, createdAt, kind, collected, extra) {
    extra = extra || {};
    var artifacts = [];
    var layers = [];
    LAYERS.forEach(function (layer) {
      var isCollected = collected.indexOf(layer) >= 0;
      var subset = [];
      if (isCollected) {
        var priv = layer === "database";
        subset.push({ id: "layer:" + layer, layer: layer, kind: "layer-json", required: true,
          privacy: priv ? "private" : "public", restoreClass: "record-only", target: null, integrity: "verified" });
        var files = {
          config: (extra.configFiles || [".env"]),
          deps: ["package.json", "package-lock.json"],
          runtime: (extra.runtimePins || [".nvmrc"]),
          database: (extra.databases || [])
        }[layer] || [];
        files.forEach(function (target) {
          subset.push({ id: "", layer: layer, kind: layer === "database" ? "sqlite-backup" : "file", required: true,
            privacy: "private", restoreClass: "supported", target: target, integrity: "verified" });
        });
      }
      layers.push({
        id: layer,
        status: isCollected ? "collected" : "skipped",
        artifactCount: subset.length,
        supportedArtifactCount: subset.filter(function (a) { return a.restoreClass === "supported"; }).length,
        recordOnlyArtifactCount: subset.filter(function (a) { return a.restoreClass === "record-only"; }).length,
        privateArtifactCount: subset.filter(function (a) { return a.privacy === "private"; }).length
      });
      artifacts = artifacts.concat(subset);
    });
    artifacts.forEach(function (a, i) { if (!a.id) a.id = "artifact-" + (i + 1); });
    var required = artifacts.filter(function (a) { return a.required; }).length;
    return {
      name: name, generation: hex(seed), createdAt: createdAt, kind: kind, schemaVersion: 2, state: "verified",
      checks: [
        { id: "snapshot.metadata", state: "ok", required: true, reasonCode: "SNAPSHOT_METADATA_VALIDATED" },
        { id: "snapshot.artifacts", state: "ok", required: true, reasonCode: "REQUIRED_ARTIFACTS_VERIFIED" }
      ],
      integrity: { state: "verified", requiredArtifacts: required, requiredVerified: required, missingArtifacts: 0, totalArtifacts: artifacts.length },
      inputCompleteness: collected.length === LAYERS.length ? "complete" : "partial",
      layers: layers,
      artifacts: artifacts,
      environment: { restorePrerequisites: "not-checked", applicationHealth: "not-tested" },
      nextStep: { action: "preserve-and-review", command: null, args: [], cwd: "current-working-directory", confirmation: "none", effects: "none", revalidates: true },
      limitations: VERIFIED_LIMITATIONS.slice()
    };
  }

  var snapshots = [
    verified("release-candidate", 11, "2026-11-07T15:42:10.000Z", "named", ["git", "deps", "runtime", "config", "docker", "database"], { databases: ["app.db"], configFiles: [".env"] }),
    verified("safety-3c8e0f2a9b1d4e67a5f0c2b8d9e1f3a4", 10, "2026-11-07T09:12:44.000Z", "named", ["config"], { configFiles: [".env"] }),
    verified("pre-schema-migration", 9, "2026-11-06T21:05:31.000Z", "named", ["git", "deps", "runtime", "config", "database"], { databases: ["app.db"] }),
    verified("hook-post-merge-0412", 8, "2026-11-06T04:12:09.000Z", "hook", ["git", "deps", "runtime", "config"]),
    verified("after-deps-bump", 7, "2026-11-05T13:47:58.000Z", "named", ["git", "deps", "runtime", "config"], { runtimePins: [".nvmrc", ".node-version"] }),
    verified("before-deps-bump", 6, "2026-11-05T11:20:02.000Z", "named", ["git", "deps", "runtime", "config"]),
    verified("auto-20261104-0930", 5, "2026-11-04T01:30:00.000Z", "auto", ["git", "deps", "config"]),
    verified("env-local-split", 4, "2026-11-03T08:16:40.000Z", "named", ["git", "config"], { configFiles: [".env", ".env.local"] }),
    verified("init-baseline", 3, "2026-11-01T02:00:12.000Z", "named", ["git", "deps", "runtime", "config", "docker"]),
    {
      name: "legacy-v1-import", generation: null, createdAt: "2026-10-20T06:00:00.000Z", kind: "named", schemaVersion: 1,
      state: "diagnostic-only",
      checks: [{ id: "snapshot.metadata", state: "not-applicable", required: true, reasonCode: "LEGACY_V1_DIAGNOSTIC_ONLY" }],
      integrity: { state: "not-checked", requiredArtifacts: null, requiredVerified: null, missingArtifacts: null, totalArtifacts: null },
      inputCompleteness: "unknown", layers: [], artifacts: [],
      environment: { restorePrerequisites: "not-checked", applicationHealth: "not-tested" },
      nextStep: { action: "preserve-and-review", command: null, args: [], cwd: "current-working-directory", confirmation: "none", effects: "none", revalidates: true },
      limitations: ["Schema v1 is diagnostic-only and its artifacts were not validated.",
        "Restore is not implemented in this Python migration candidate.",
        "Application health and runtime behavior were not tested."]
    },
    { name: "tampered-copy", state: "invalid", reasonCode: "SNAPSHOT_INTEGRITY_FAILED",
      checks: [{ id: "snapshot.inspection", state: "issue", required: true, reasonCode: "SNAPSHOT_INTEGRITY_FAILED" }] },
    { name: "half-written", state: "invalid", reasonCode: "SNAPSHOT_POINTER_MISSING",
      checks: [{ id: "snapshot.inspection", state: "issue", required: true, reasonCode: "SNAPSHOT_POINTER_MISSING" }] },
    { name: "acl-locked", state: "unknown", reasonCode: "SNAPSHOT_ACCESS_DENIED" }
  ];

  var diagnostics = snapshots
    .filter(function (s) { return s.state !== "verified" && s.state !== "diagnostic-only"; })
    .map(function (s) { return { name: s.name, state: s.state, reasonCode: s.reasonCode }; });
  diagnostics.push({ reasonCode: "UNRECOGNIZED_INVENTORY_ENTRIES", count: 1 });

  var list = {
    resultSchemaVersion: 2, toolVersion: "0.1.0a37", command: "list",
    inventory: { state: "incomplete", snapshotCount: snapshots.length, diagnosticCount: diagnostics.length, unrecognizedEntryCount: 1 },
    snapshots: snapshots, diagnostics: diagnostics,
    legacy: { privateDatabasePathCount: 0, diagnosticCount: 0 }
  };

  var compares = [
    { a: "before-deps-bump", b: "after-deps-bump", exitCode: 0, text: [
      "[git]",
      "~ Git commit: 4be1a07 -> 9c03f5e",
      "= Git attachment: main",
      "= Git worktree: 0 changed path(s) on both sides",
      "= config .env: bytes match (values withheld)",
      "= config .env.local: absent on both sides",
      "[deps]",
      "  = lockfile: package-lock.json (same fingerprint)",
      "  ~ lockfile fingerprint changed",
      "  ~ 7 resolved package version(s) changed (names and values withheld)",
      "  ~ package.json dependency declarations changed (values withheld)",
      "  = package.json and package-lock.json declarations match in both snapshots",
      "[runtime]",
      "  = node version matches",
      "  ~ npm version changed",
      "  + runtime pin .node-version present in B only (contents withheld)",
      "  = runtime pin .nvmrc contents match (contents withheld)",
      "[database]",
      "  = no recorded databases in either snapshot",
      "[docker]",
      "  ? Docker Compose service comparison is not implemented in this migration slice",
      "Comparison completed: 5 supported difference(s) across Git, configuration, dependency metadata, and runtime pins."
    ].join("\n") },
    { a: "pre-schema-migration", b: "release-candidate", exitCode: 0, text: [
      "[git]",
      "~ Git commit: 7d21e90 -> e44b8c2",
      "~ Git attachment: feature/schema-v3 -> main",
      "~ Git worktree: 2 changed path(s) -> 0 changed path(s)",
      "~ config .env: contents changed (values and private digests withheld)",
      "= config .env.local: absent on both sides",
      "[deps]",
      "  = lockfile: package-lock.json (same fingerprint)",
      "  = resolved package versions match",
      "  = package.json dependency declarations match (values withheld)",
      "  ! package.json and package-lock.json declarations disagree in A (values withheld)",
      "[runtime]",
      "  = node version matches",
      "  = npm version matches",
      "  = runtime pin .nvmrc contents match (contents withheld)",
      "[database]",
      "  ~ database app.db: recorded schema changed",
      "  ~ database app.db: recorded table list changed",
      "  ~ database app.db: recorded row count changed",
      "  ? database app.db: row contents not compared",
      "[docker]",
      "  ? Docker Compose service comparison is not implemented in this migration slice",
      "Comparison completed: 7 supported difference(s) across Git, configuration, dependency metadata, and runtime pins."
    ].join("\n") },
    { a: "env-local-split", b: "auto-20261104-0930", exitCode: 0, text: [
      "[git]",
      "= Git commit: same",
      "= Git attachment: main",
      "~ Git worktree: 0 changed path(s) -> 1 changed path(s)",
      "= config .env: bytes match (values withheld)",
      "~ config .env.local: present on one side only (values withheld)",
      "[deps]",
      "? deps not compared (snapshot A: no supported dependency manifest was collected; snapshot B collected)",
      "[runtime]",
      "? runtime not compared (snapshot A: runtime layer skipped; snapshot B: runtime layer skipped)",
      "[database]",
      "  = no recorded databases in either snapshot",
      "[docker]",
      "  ? Docker Compose service comparison is not implemented in this migration slice",
      "Comparison completed: 2 supported difference(s) across Git, configuration, dependency metadata, and runtime pins."
    ].join("\n") },
    { a: "release-candidate", b: null, exitCode: 0, text: [
      "[git]",
      "= Git commit: same",
      "= Git attachment: main",
      "~ Git worktree: 0 changed path(s) -> 4 changed path(s)",
      "~ config .env: contents changed (values and private digests withheld)",
      "= config .env.local: absent on both sides",
      "[deps]",
      "  = lockfile: package-lock.json (same fingerprint)",
      "  = resolved package versions match",
      "  = package.json dependency declarations match (values withheld)",
      "[runtime]",
      "  = node version matches",
      "  = npm version matches",
      "  = runtime pin .nvmrc contents match (contents withheld)",
      "[database]",
      "  ? live database schema and row counts not compared (no live database read was requested)",
      "  ? database row contents not compared",
      "[docker]",
      "  ? Docker Compose service comparison is not implemented in this migration slice",
      "Comparison completed: 2 supported difference(s) across Git, configuration, dependency metadata, and runtime pins."
    ].join("\n") }
  ];

  var doctorGeneral = {
    tools: { git: "git version 2.51.0.windows.1", sqliteCli: "3.54.1", pythonSqlite: "3.49.1" },
    checks: [
      { id: "git worktree", state: "issue", reasonCode: "GIT_WORKTREE_DIRTY", detail: "Git reports 4 changed path(s); no path names or contents were included in the report." },
      { id: "node", state: "ok", reasonCode: "NODE_AVAILABLE", detail: "Node CLI is available for Node project workflows." },
      { id: "npm", state: "ok", reasonCode: "NPM_AVAILABLE", detail: "npm CLI is available for dependency management." },
      { id: "sqlite CLI", state: "ok", reasonCode: "SQLITE_CLI_AVAILABLE", detail: "SQLite command-line tool is available." },
      { id: "docker", state: "unknown", reasonCode: "TOOL_NOT_FOUND", detail: "docker was unavailable for this probe." },
      { id: "Python SQLite", state: "ok", reasonCode: "PYTHON_SQLITE_AVAILABLE", detail: "Python sqlite3 module 3.49.1 is available." },
      { id: "deps sync", state: "ok", reasonCode: "DEPENDENCIES_MATCH_LOCKFILE", detail: "Installed direct dependency versions match the lockfile." },
      { id: "env keys", state: "issue", reasonCode: "CONFIG_KEYS_CHANGED", detail: "1 configuration file/key name change(s) since snapshot release-candidate: .env:+FEATURE_FLAG_X" }
    ],
    verdict: "issue"
  };

  var doctorTasks = [
    {
      resultSchemaVersion: 1, toolVersion: "0.1.0a37", command: "doctor", task: "config-snapshot",
      projectContext: { scope: "current-working-directory", pathDisclosure: "omitted", gitRepository: "unknown" },
      checks: [
        { id: "project.context", state: "ok", required: true, reasonCode: "CURRENT_DIRECTORY_VERIFIED", message: "The exact current directory is a real directory; no parent discovery was used." },
        { id: "config.applicability", state: "ok", required: true, reasonCode: "SUPPORTED_CONFIG_PRESENT", message: "A supported configuration file is present; contents were not read." },
        { id: "python.snapshot-implementation", state: "ok", required: true, reasonCode: "CONFIG_SNAPSHOT_SUPPORTED", message: "A new-name snapshot can collect supported config files; Git and Docker layers may be skipped, overwrite is refused, and explicit SQLite seed is a separate option." },
        { id: "privacy.boundary", state: "unknown", required: true, reasonCode: "PRIVATE_STORAGE_NOT_VERIFIED", message: "This read-only check does not verify the caller's filesystem access controls or Git exclusion for the private state directory." }
      ],
      summary: { state: "unknown", requiredIssueCount: 0, requiredUnknownCount: 1 }
    },
    {
      resultSchemaVersion: 1, toolVersion: "0.1.0a37", command: "doctor", task: "config-restore", snapshot: "release-candidate",
      projectContext: { scope: "current-working-directory", pathDisclosure: "omitted", gitRepository: "unknown" },
      checks: [
        { id: "project.context", state: "ok", required: true, reasonCode: "CURRENT_DIRECTORY_VERIFIED", message: "The exact current directory is a real directory; no parent discovery was used." },
        { id: "snapshot.integrity", state: "issue", required: true, reasonCode: "EGIT_DIRTY", message: "The current snapshot or project state does not meet the supported single-config restore preconditions." },
        { id: "python.restore-implementation", state: "issue", required: true, reasonCode: "PYTHON_RESTORE_LIMITED", message: "Apply supports one .env/.env.local target with a private safety generation and verified rollback. Existing database overwrite, dependency/runtime restore, Git mutation, and non-Windows SQLite creation remain unavailable." },
        { id: "privacy.boundary", state: "unknown", required: false, reasonCode: "PRIVATE_STORAGE_ACCESS_CONTROLS_NOT_CHECKED", message: "Filesystem access controls for private plaintext are not checked by this read-only diagnostic; this result is not write authorization." }
      ],
      summary: { state: "blocked", requiredIssueCount: 2, requiredUnknownCount: 0 }
    }
  ];

  var operations = [
    { resultSchemaVersion: 1, operationId: "3c8e0f2a9b1d4e67a5f0c2b8d9e1f3a4", status: "completed", phase: "verified",
      classification: "completed", target: ".env", source: { snapshot: "env-local-split", generation: hex(4) },
      safety: { name: "safety-3c8e0f2a9b1d4e67a5f0c2b8d9e1f3a4", generation: hex(10) },
      current: { exists: true, size: 214 }, stageIntegrity: "verified-by-target", recoveryActions: [],
      resolver: "completed", businessValues: "withheld" },
    { resultSchemaVersion: 1, operationId: "a1f09c3e7b2d48e6901b5c7d3e2f4a10", status: "rolled-back", phase: "rolled-back",
      classification: "rolled-back", target: ".env", source: { snapshot: "before-deps-bump", generation: hex(6) },
      safety: { name: "safety-a1f09c3e7b2d48e6901b5c7d3e2f4a10", generation: hex(21) },
      current: { exists: true, size: 198 }, stageIntegrity: "not-needed", recoveryActions: [],
      resolver: "completed", businessValues: "withheld" },
    { resultSchemaVersion: 1, operationId: "f7e6d5c4b3a291807f6e5d4c3b2a1908", status: "in-progress", phase: "published",
      classification: "published-awaiting-verification", target: ".env", source: { snapshot: "init-baseline", generation: hex(3) },
      safety: { name: "safety-f7e6d5c4b3a291807f6e5d4c3b2a1908", generation: hex(22) },
      current: { exists: true, size: 176 }, stageIntegrity: "verified-by-target", recoveryActions: ["--continue", "--rollback"],
      resolver: "active-or-not-started", businessValues: "withheld" }
  ];

  var demo = { resultSchemaVersion: 1, command: "demo", state: "passed", fixture: "synthetic-config-only",
    stages: ["snapshot", "compare", "preview", "restore", "rollback"], applicationHealth: "not-tested",
    gitState: "not-exercised", businessValues: "synthetic-and-withheld", durationMs: 412 };

  window.PROJECT_STATE_SAMPLE = {
    bundleSchema: "project-state-dashboard/1",
    meta: { source: "sample", generatedAt: "2026-11-08T01:00:00+08:00", toolVersion: "0.1.0a37", projectLabel: "synthetic-demo-app" },
    list: list,
    doctor: { general: doctorGeneral, tasks: doctorTasks },
    compares: compares,
    operations: operations,
    demo: demo
  };
})();
