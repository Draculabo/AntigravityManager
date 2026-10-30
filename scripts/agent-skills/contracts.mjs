import { collectSkillInventory, readSkillPolicy } from './inventory.mjs';

/** Mechanical consistency only; competing descriptions require semantic review. */
export function inspectSkills(rootDir) {
  let policy;
  try {
    policy = readSkillPolicy(rootDir);
  } catch (error) {
    return {
      skills: [],
      errors: [`scripts/agent-skills/policy.json: ${error.message}`],
      advisories: [],
    };
  }
  const { skills, errors } = collectSkillInventory(rootDir, policy);
  const declaredPairs = new Set();
  for (const mirror of policy.mirrors) {
    const slugs = [
      ...new Set(
        skills
          .filter(
            (skill) => mirror.roots.includes(skill.root) && skill.slug.startsWith(mirror.prefix),
          )
          .map((skill) => skill.slug),
      ),
    ].sort();
    if (slugs.length === 0) {
      errors.push(`${mirror.owner}: mirror prefix ${mirror.prefix} has no valid entries`);
    }
    for (const slug of slugs) {
      const entries = mirror.roots.map((root) =>
        skills.find((skill) => skill.root === root && skill.slug === slug),
      );
      for (const [index, entry] of entries.entries()) {
        if (!entry) {
          errors.push(
            `${mirror.roots[index]}/${slug}/SKILL.md: missing valid mirror entry (${mirror.owner})`,
          );
        }
      }
      const present = entries.filter(Boolean);
      const first = present[0];
      for (const entry of present.slice(1)) {
        if (entry.content !== first.content) {
          errors.push(
            `${first.path} <> ${entry.path}: mirror entry content differs (${mirror.owner})`,
          );
        }
      }
      for (const left of present) {
        for (const right of present) {
          declaredPairs.add(`${left.path}\0${right.path}`);
        }
      }
    }
  }
  const advisories = [];
  for (const [index, left] of skills.entries()) {
    for (const right of skills.slice(index + 1)) {
      if (
        left.name === right.name &&
        left.realFile !== right.realFile &&
        !declaredPairs.has(`${left.path}\0${right.path}`)
      ) {
        advisories.push(
          `${left.path} <> ${right.path}: same name without a declared mirror; review invocation overlap`,
        );
      }
    }
  }
  return {
    skills: skills.map(({ content: _content, realFile: _realFile, ...skill }) => skill),
    errors,
    advisories,
  };
}
