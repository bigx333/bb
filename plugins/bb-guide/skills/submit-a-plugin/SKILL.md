---
name: submit-a-plugin
description: "Prepare and submit a BB plugin to the Community marketplace when publication or a marketplace PR is requested."
---

# Submit a plugin

Submit a public plugin to the BB Community marketplace. The marketplace stores
plugin metadata. The plugin code stays in its Git repository or npm package.

## Choose the task

If the user asks only for instructions, explain the process without remote
changes.

If the user asks for a submission, prepare and validate everything possible.
Ask only for information that the plugin, Git, npm, GitHub, or marketplace
cannot supply.

A submission request does not approve a release. Before the first Git push, tag,
npm publication, or other release mutation, show the exact account, repository,
commit, package, version, source, and commands. Get approval for that release.

Do not expose credentials, private URLs, or local secrets.

## Choose the validation environment

Follow the user's and repository's validation policy for both the plugin and
marketplace. Do not assume tests, typechecks, builds, or package checks may run
locally. When policy requires remote CI, run them only there and reuse passing
results for the exact unchanged candidate. Read-only inspection and permitted
development-app screenshot capture are separate from automated checks.

If an authorized validation environment is unavailable, report the missing
checks. Do not substitute prohibited local checks or upload private code to a
new service. A release still needs successful required checks before publication.

## Read current contracts

The marketplace contract can change independently from BB releases. Read these
files from the default branch of https://github.com/get-bb/marketplace:

- README.md
- schema/marketplace-v2.schema.json
- marketplace.base.json, for the current category IDs
- icons/README.md
- At least two current files in entries/

An entry file uses the version 2 entry fields. Read
schema/marketplace-v2.schema.json for those fields. The older
schema/marketplace.schema.json file describes the frozen version 1 output
document. Do not use it as the entry contract.

Treat those files as the contract. Use this skill for workflow and quality
rules.

## Workflow

1. Read repository instructions, package.json, Git state, and release state.
2. Validate the plugin and its package in the permitted validation environment.
3. Select and verify one public release source.
4. Prepare the entry, vendored icon, screenshots, and overview file. Copy
   PLUGIN_OVERVIEW.md when available; otherwise get approval for a draft.
5. Inspect the prepared files and get separate approval for the exact release
   before any release mutation.
6. Publish the approved release if needed and verify its public availability.
7. Commit only the entry, icon, screenshots, and overview file. Push the
   approved marketplace branch and open a PR from the submitter account.
8. Verify the marketplace checks for that exact PR head. When validation runs
   through PR CI, opening the PR precedes those checks; report them as pending
   until they finish.

Read these references as the task reaches each stage:

- Read references/plugin-release.md before validating or releasing a plugin.
- Read references/marketplace-entry.md before you create the entry, icon,
  screenshots, or overview file. It states what a good entry and description
  hold, how to capture screenshots with a harness browser or computer
  automation tool, what to ask the user for when the harness has no such
  tool, which markdown the long-form description can use, and what to do when
  the plugin has no PLUGIN_OVERVIEW.md yet. It ends with a quality check to run
  before the pull request.
- Read references/pull-request.md before cloning, validating, or submitting
  the marketplace repository.

Use scripts/derive-plugin-id.mjs to calculate the same plugin ID that BB uses:

```sh
node /PATH/TO/THIS/SKILL/scripts/derive-plugin-id.mjs /PATH/TO/PLUGIN/package.json
```

## Completion

Return the pull request URL, released source, and validation results. Do not wait
for a merge unless the user asks.

A compatible release within an existing tracking range usually needs no new
marketplace pull request. Open another pull request when source, branding,
description, long-form description, category, screenshots, ownership, tag, or
range changes.
