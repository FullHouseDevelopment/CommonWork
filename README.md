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
