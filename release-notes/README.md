# Reviewed release documents

Store the reviewed story for each release as `v<VERSION>.json` in this directory. Prepare it only
after the release's source changes are committed, and commit the document separately from source
changes. The semantic-release generator validates its range before publication.

See the [release notes workflow](../docs/development.md#release-notes) for draft and preview commands,
document fields, source attribution and validation behavior. Generated fact files and previews
belong under ignored `artifacts/` rather than in this directory.
