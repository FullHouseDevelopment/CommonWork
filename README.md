# CommonWork

Shared engineering automation for Full House Development and Levron Games.

This public repository is the canonical home for reusable GitHub Actions workflows and
supporting actions that are consumed across repositories and organizations.

## Composable actions

CommonWork exposes small step-level capabilities under `.github/actions/` so callers can assemble custom jobs without copying shell setup:

- `setup-dotnet`
- `setup-node`
- `setup-python`
- `setup-godot`
- `setup-android-sdk`
- `install-godot-templates`
- `godot-import`
- `godot-runtime-smoke`
- `godot-export`
- `sign-android-apk`
- `upload-artifact-with-fallback`
- `dotnet-validate`
- policy/version actions already used by shared workflows

Use an action when the unit of reuse is a capability inside one job. Use a reusable workflow when the unit of reuse owns runners, matrices, permissions, job dependencies, or higher-level orchestration.

External callers should pin actions and workflows to a full CommonWork commit SHA.

## Reusable workflows

- `.github/workflows/profile-guard.yml` — combined workflow policy + PR version intent in one runner job
- `.github/workflows/profile-baseline.yml`
- `.github/workflows/profile-dotnet.yml`
- `.github/workflows/profile-godot.yml`
- `.github/workflows/profile-maui.yml`
- `.github/workflows/profile-node-next.yml`
- `.github/workflows/profile-python.yml`
- `.github/workflows/snapshot-intent.yml`
- `.github/workflows/version-intent.yml`
- `.github/workflows/version-tag.yml`
- `.github/workflows/release-validation.yml` — opt-in release-grade validation/packaging orchestration for .NET, Node, Python, and Godot profiles; publication remains consumer-owned

Consumers should pin reusable workflows to a full CommonWork commit SHA. The shared profiles themselves are composed from the small actions above so there is one implementation of each common capability rather than a workflow-specific copy.

## Light vs heavy CI

Shared profiles use a common `tier` convention:

- `light` is the default for development PRs. It keeps source validation, build/test checks, and cheap product sanity checks while avoiding release evidence, platform fan-out, exports, and packaging.
- `heavy` is for trusted `main`/release validation. It enables release-grade extras such as platform product-shape jobs, runtime/export checks, and artifact evidence.

The Godot profile also supports explicit `export_in_light: true` for intentional PR snapshots. The MAUI profile supports `platforms_in_light: true` when a specific PR genuinely needs platform validation.

Prefer `profile-guard.yml` instead of separate baseline and version-intent jobs so policy plumbing pays one runner-start cost instead of two.

Reusable validation profiles inherit the caller job's explicit `permissions` instead of imposing a reusable-workflow ceiling. This lets light/read-only jobs stay read-only while export/fallback callers can opt into `contents: write` only when they actually need it.

AutoDev-specific product CI, packaging, installer verification, and release publication
remain in the AutoDev repository.

## Snapshot artifacts

Pull requests opt in to downloadable snapshot artifacts by adding a line containing exactly `+snapshot` to the PR body. Snapshot artifacts should use a three-day retention period unless a repository has a documented reason to retain them longer.

When the shared Godot profile is asked to upload an export, it first uses GitHub Actions artifact storage. If that upload fails (for example because the Actions artifact quota is exhausted), the profile can fall back to a rolling `ci-snapshots` prerelease in the caller repository and upload the export as a release asset instead. The workflow only fails for storage when both paths fail.

Release fallback is enabled by default. Callers that enable export uploads should grant the Godot reusable-workflow job `contents: write`; reusable workflows cannot elevate a caller token that was limited to `contents: read`.

```yaml
godot:
  uses: FullHouseDevelopment/CommonWork/.github/workflows/profile-godot.yml@<full-commit-sha>
  permissions:
    contents: write
  with:
    tier: light
    export_in_light: true
    export_preset: Android
    export_output: artifacts/app.apk
    upload_artifact: true
```

Set `artifact_release_fallback: false` to keep the old fail-on-artifact-upload behavior, or `artifact_release_tag` to use a different rolling prerelease tag.


## Change-aware CI planning for consumers

Use `.github/workflows/ci-impact.yml` as a lightweight first job in each participating
consumer CI. Consumers keep a small `.github/ci-impact.json` file with version 1,
`fallback: "full"`, and arrays of path globs under `groups`.

The classifier resolves the PR and changed files from the **GitHub API**, and reads
the impact policy from the **exact PR base SHA**, never from the untrusted PR head.
Renames inspect both old and new paths. Unknown files, errors, missing policies,
policy modifications and changes explicitly in the `full` group require full CI.
Every plan runs the `workflow` policy/syntax group.

Group outputs: `workflow`, `python`, `control`, `dotnet`, `packaging`,
`box`, `windows`, `oci`, `version`, `full`, and `reason`.
Each is the string `true` or `false` except `reason`. The plan publishes
a GitHub Step Summary explaining selections. Non-PR workflows (push/release/
manual dispatch) are **always full**, and `force_full` may only expand scope.

Consumers must pin the reusable workflow to a full CommonWork commit SHA.
Only the **planner** owns change classification; callers use simple `needs` and
`if` expressions. A fixed required CI gate must validate that each planned
group actually passed; GitHub's skipped-job conclusion alone is not enough.
Keep draft guards ahead of the planner, and keep main/release CI unconditionally
full. On first adoption, the trusted base branch has no policy yet, so the
first integration PR intentionally runs full CI.

Sample policy:

```json
{
  "version": 1,
  "fallback": "full",
  "groups": {
    "workflow": [".github/workflows/**", ".github/actions/**"],
    "python": ["automation/**"],
    "control": ["src/Control/**"],
    "dotnet": ["src/**"],
    "packaging": ["deploy/**"],
    "box": ["box/**"],
    "windows": ["windows/**"],
    "oci": ["integrations/oci/**"],
    "version": ["version/**"],
    "docs": ["docs/**", "*.md"],
    "full": [".github/ci-impact.json"]
  }
}
```

Policies are deliberately repository-specific. Cover shared/build/test inputs
conservatively; any unclassified path makes CI full rather than allowing a false
negative. Overrides are GitHub-authorized workflow dispatches, not PR-body
commands.


## Within-PR verified check reuse (opt-in)

The standalone `.github/actions/ci-reuse` action is a **separate decision**
from impact planning. A check may be required by impact but reuse a past
successful execution within the **same PR** only if all of these hold:

- Current PR source and base identity match the GitHub event.
- The previous GitHub Actions run is complete (success or failure), belongs to
  that PR, has the same base commit/ref and workflow, and uses an ancestor head SHA.
  The specific reusable job itself must have completed successfully; failures
  in unrelated jobs do not invalidate that job's result.
- The exact named job in that run completed successfully (not skipped).
- GitHub's complete intervening diff contains only changes explicitly
  marked safe for that check by the **trusted base-branch**
  `.github/ci-reuse.json`. Renames check both names.
- Unknown inputs, incomplete pagination, drift, API errors, missing proof,
  or any PR targeting main/release branch conservatively trigger execution.

Call the action from one lightweight job after the draft and impact guards,
with `workflow` set to the caller entry point (for example `ci-develop.yml`),
`GITHUB_TOKEN: ${{ github.token }}`, and `pull-requests: read` plus
`actions: read` and `contents: read` permissions. Its outputs are
`python`, `python_windows`, `control`, `dotnet_linux`,
`dotnet_windows`, `python_reference`, and `reason`.

Consumers add only a small policy listing each desired job's **exact GitHub
Actions job name** and its known-safe changed paths. Unknown or broad paths
must not be declared unrelated casually; test sources, workflow definitions,
tool versions, dependency locks, and shared runtime inputs are relevant
unless explicitly proven otherwise.

A job is skipped only when this trusted action returns `true`. The fresh
aggregate CI gate must accept that skip **only if it sees a successful reuse
decision job and the exact corresponding proof output**. Reuse never changes
GitHub's original check conclusion or fabricates a passing test execution.
The default is *no reuse*, and the first adoption PR necessarily executes all
required jobs because the base branch has no reuse policy yet.

This intentionally does not include cross-PR, cross-branch, cross-repository,
or release check reuse.
