# Project Skill Maintenance

Use this reference when adding, upgrading or auditing repository-local skills. Root and subtree
instructions remain authoritative for standing constraints; skills own selectively loaded procedures.
The [policy](../../scripts/agent-skills/policy.json) declares managed roots, origin overrides and
intentional entry mirrors. It is not a second catalog of every installed skill.

## Inspect the managed entries

```powershell
pnpm run skills:inventory
pnpm run skills:inventory --json
pnpm run check:agent-contracts
```

Inventory and contract checks are read-only. They use the current worktree, including new entries
under managed roots, without inspecting global skills, nested worktrees or other repositories.
Empty directories without `SKILL.md` are not installed entries. Repository-internal links may share
an entry; links outside the repository fail before the document is read. Individual input documents
are limited to 1 MiB. No service, model request, dependency installation or cleanup is involved.

The human report lists source, path, owner and line count. JSON additionally includes names,
descriptions, generator metadata, errors and advisories. Output contains repository-authored text;
bound it through the calling tool when inspecting large catalogs. A nonzero result means structural
errors, not poor routing accuracy. Advisories do not fail the check.

## Ownership and updates

| Source    | Identification                                   | Maintenance                                                                                                   |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Project   | No generator, upstream author or origin override | Edit the owning entry and its focused checks.                                                                 |
| Upstream  | `metadata.author` or an origin override          | Follow the package's update mechanism; review its diff and retain project facts in owning project references. |
| Generated | `metadata.generatedBy`                           | Regenerate through the owning tool and review every affected harness entry.                                   |

These labels describe maintenance provenance, not security or invocation permissions. Metadata
can be incomplete; use a narrow origin override for an imported skill whose entry does not identify
its upstream owner. Overrides must identify an existing, valid entry in a managed root.

OpenSpec currently generates entry documents under both `.codex/skills` and `.claude/skills`.
The declared mirror checks the union of matching skill directory names and compares their complete
`SKILL.md` text after CRLF normalization. A one-sided addition, deletion or changed body fails.
It does not compare supplementary resources or prove that either harness discovers the skill.
Keep the generator's directories and entry text intact; update both through its supported workflow.
If a future generator intentionally emits different entry documents, change the mirror policy only
with evidence of that contract, its owner and the removal condition for the old relationship.

Every mirror declaration has an owner, reason and removal condition. No command copies, fixes,
stages or selects a winning version. Preserve unrelated edits before resolving a reported drift.

## Mechanical and semantic checks

The existing Agent contract gate rejects malformed or missing entry frontmatter, empty names or
descriptions, invalid declared origins, missing managed roots and mirror drift. Unknown harness
fields are accepted. Project-owned entries also receive the existing local Markdown-link and pnpm
command checks; vendored and generated bodies keep their upstream conventions.

Exact duplicate names outside a declared mirror or shared physical entry are inventory advisories.
Review their actual invocation boundaries before merging or deleting anything. Description length,
age and similar wording alone do not establish a defect. Review whether:

- The same request could select competing procedures, or complementary skills have clear roles.
- Entry descriptions match the current body, consumers and referenced code.
- Explicit-only invocation metadata is actually supported by each active harness.
- The skill duplicates a standing rule instead of linking to its canonical owner.
- A rename or update leaves stale links or named handoffs.

Use [routing evaluation](../testing/agent-routing.md) for observed selection mistakes. Structural
checks cannot establish model behavior. The [historical review procedure](../testing/review-evaluation.md)
addresses confirmed reviewer misses or harmful advice; it is not a mandatory model comparison for
each metadata or workflow edit.

## Change and recovery

Run the focused skill tests through `pnpm run check:agent-contracts`. Changes to check registration
also require `pnpm run test:quality` and `pnpm run check:quality`. Format only changed paths; see
[documentation instructions](../AGENTS.md) for `.agents/` formatting.

Recover a faulty checker change by reverting its task-owned policy, implementation, tests and
registration together, preserving unrelated work. Skill entry locations and application data do
not migrate. Upstream updates retain their own reviewed diff and recovery procedure.
