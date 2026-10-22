# Non-author usability trial card

This task card is for one consenting non-author operator using two disposable npm/Git project copies. Do not use a production project, real secrets, or irreplaceable data. The operator should be able to stop at any refusal without deleting locks, journals, pins, or snapshots.

## Eligibility and setup

- Two distinct, disposable projects with Git initialized and a committed baseline.
- At least one supported local configuration file excluded from Git before adding a synthetic value.
- No production database, real credential, or unrelated private workspace content.
- Record the tool version, OS, Node, Git, project-copy paths, and which copy is used for each task.
- The facilitator may prepare the copies but must not coach command interpretation during the task.

## Task

Starting at each project root, ask the operator to:

1. Find help and identify which states the tool can restore.
2. Diagnose the project and save a named snapshot before a synthetic config change.
3. Change one synthetic config value and find the change with `compare`.
4. Preview selective config restore, explain what preview does and does not freeze, then explicitly authorize restore.
5. Check the restored bytes and explain why the app still needs a manual restart/health check.
6. Run the exact printed rollback command unchanged from the same project root and verify the prior config bytes return.
7. Explain any refusal and identify which safety evidence must be preserved.

## Record without coaching

For each project copy record elapsed time, commands attempted, number of manual steps, errors/refusals, help consulted, whether the operator proceeded safely, and any facilitator intervention. Do not record real configuration values. Do not infer ease or value from a successful automated test.

## Interview questions

- Have you encountered a startup/configuration drift like this? How did you resolve it before?
- Which steps were clear or confusing: project root, snapshot name, preview, `--yes`, and rollback?
- What do you understand the tool protects, and what remains outside its protection?
- Did you understand that restore does not restart the app or prove it healthy?
- How many steps and how much time did this take compared with your usual method?
- Would you use it for a similar task again? Why or why not?

## Feedback form

```text
Operator role (no personal name required):
Project copy A/B labels:
Tool/OS/Node/Git versions:
Elapsed time per copy:
Manual steps per copy:
Commands/help needed:
Refusals or errors and whether understood:
Facilitator intervention:
What was believed to be protected:
What was understood to remain unverified:
Would use again (yes / unsure / no) and reason:
Unexpected risks or data concerns:
```

Keep this form separate from project data. The trial is not evidence of general recovery safety or application health.
