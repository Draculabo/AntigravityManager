import type { Tool } from './types';

const SKILL_READ_INSTRUCTION = [
  '',
  '**[CRITICAL INSTRUCTION FOR GEMINI - HOW TO READ SKILL.md]**',
  'You do not have a direct `view_file` or `read_file` tool.',
  'To open and read a referenced SKILL.md, you must use the `shell_command` tool.',
  'In PowerShell, run `Get-Content -Raw -LiteralPath "C:\\path\\to\\SKILL.md"`.',
  'Do not guess or call file-reading tools that are not available.',
  '',
].join('\n');

/**
 * Add an executable Skill-reading hint only when both the Skill context and
 * the required shell tool are present in the request.
 */
export function enhanceGeminiSkillsPrompt(systemInstruction: string, tools?: Tool[]): string {
  const hasShellCommand = tools?.some((tool) => {
    const name = tool.name?.toLowerCase();
    return name === 'shell_command' || name?.endsWith('__shell_command');
  });
  if (!hasShellCommand) {
    return systemInstruction;
  }

  if (systemInstruction.includes('</skills_instructions>')) {
    return systemInstruction.replaceAll(
      '</skills_instructions>',
      `${SKILL_READ_INSTRUCTION}</skills_instructions>`,
    );
  }
  if (systemInstruction.includes('</skills>')) {
    return systemInstruction.replaceAll('</skills>', `${SKILL_READ_INSTRUCTION}</skills>`);
  }

  return systemInstruction;
}
