# CommonWork

Shared engineering automation for Full House Development and Levron Games.

This public repository is the canonical home for reusable GitHub Actions workflows and
supporting actions that are consumed across repositories and organizations.

## Reusable workflows

- `.github/workflows/profile-baseline.yml`
- `.github/workflows/profile-dotnet.yml`
- `.github/workflows/profile-godot.yml`
- `.github/workflows/profile-maui.yml`
- `.github/workflows/profile-node-next.yml`
- `.github/workflows/profile-python.yml`
- `.github/workflows/snapshot-intent.yml`
- `.github/workflows/version-intent.yml`
- `.github/workflows/version-tag.yml`

Consumers should pin reusable workflows to a full CommonWork commit SHA.

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
    export_preset: Android
    export_output: artifacts/app.apk
    upload_artifact: true
```

Set `artifact_release_fallback: false` to keep the old fail-on-artifact-upload behavior, or `artifact_release_tag` to use a different rolling prerelease tag.
