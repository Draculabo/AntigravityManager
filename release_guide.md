# Release Guide

This guide explains how to package and release **Antigravity Manager** to GitHub Releases with an auto-generated changelog.

## Prerequisites

1.  **GitHub Repository**: Ensure your code is pushed to `https://github.com/Draculabo/AntigravityManager`.
2.  **GitHub Token**: The workflow uses the automatic `GITHUB_TOKEN`, so no manual secret setup is usually required for basic releases.

## Workflow Overview

We use a combination of **Electron Forge** and **GitHub Actions** to automate the release process.

1.  **Release Drafter**: (Optional but recommended) You can set up a separate workflow to draft releases as PRs are merged. For now, we are focusing on the publish step.
2.  **Publish Workflow**: Triggered when you push a tag starting with `v` (e.g., `v0.0.1`).

## How to Release

### Step 1: Prepare the Release locally

1.  Update the version in `package.json` to the desired version (e.g., `0.0.1`).
    ```json
    "version": "0.0.1"
    ```
2.  Commit this change.
    ```bash
    git add package.json
    git commit -m "chore: bump version to 0.0.1"
    ```

### Step 2: Push the Tag

Trigger the release by pushing a tag.

```bash
git tag v0.0.1
git push origin v0.0.1
```

### Step 3: Watch the Action

1.  Go to your GitHub repository: [AntigravityManager Actions](https://github.com/Draculabo/AntigravityManager/actions)
2.  You should see a "Publish Release" workflow running.
3.  Once completed, it will create a Draft Release (or published release depending on config) in the "Releases" section.

### Step 4: Verify and Publish

1.  Go to the **Releases** tab in your repository.
2.  You will see a new release for `v0.0.1`.
3.  It will contain the build assets (exe, zip, etc.) for Windows (since the runner is `windows-latest`).
4.  Edit the release notes if needed (Release Drafter can help automate this in the future if integrated into a PR workflow).
5.  Click **Publish release** if it is in draft mode.

## Configuration Details

-   **`forge.config.ts`**: Configures the GitHub publisher.
-   **`.github/workflows/publish.yaml`**: The CI/CD definition that runs `npm run publish`.
-   **`.github/release-drafter.yml`**: Configuration for categorizing changes (Features, Fixes, etc.).

## Troubleshooting

-   **403/404 Errors**: Ensure the `GITHUB_TOKEN` has `contents: write` permissions in the workflow file (already added).
-   **Missing Assets**: Check the build logs to see if `electron-forge make` succeeded.
