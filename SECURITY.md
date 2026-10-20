# Security policy

## Reporting a vulnerability

Do not include credentials, snapshots, database files, private project data, or recovery journals in a public issue.

If private vulnerability reporting is enabled in the GitHub repository, use the repository's Security reporting flow. If it is not available, contact the repository maintainer through a verified channel listed by the repository owner and request a private disclosure route before sending sensitive details. No response-time guarantee is made here.

## Data handling

`project-state` may place plaintext private artifacts under `.project-state/secrets/`. Treat this directory as sensitive. Hashes provide integrity checking, not author authentication. Do not upload real snapshots or user project data to CI or public issues.

Security fixes should include a synthetic regression test and state what was actually validated: real CLI, injected failure, child-process termination, or an unverified durability/platform case.
