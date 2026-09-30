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
- `.github/workflows/release.yml` — opt-in release orchestration for .NET, Node, Python, and Godot profiles

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
