import { fileURLToPath } from 'node:url';
import { inspectSkills } from './contracts.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--json')) {
  console.error('Usage: pnpm run skills:inventory [--json]');
  process.exitCode = 2;
} else {
  const report = inspectSkills(fileURLToPath(new URL('../../', import.meta.url)));
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const skill of report.skills) {
      console.log(`${skill.source}\t${skill.path}\t${skill.owner}\t${skill.lines} lines`);
    }
    for (const advisory of report.advisories) {
      console.log(`ADVISORY ${advisory}`);
    }
    for (const error of report.errors) {
      console.error(`ERROR ${error}`);
    }
    console.log(
      `${report.skills.length} entries; ${report.errors.length} errors; ${report.advisories.length} advisories`,
    );
  }
  process.exitCode = report.errors.length > 0 ? 1 : 0;
}
