import { describe, expect, it } from 'vitest';

import {
  adaptCommandArguments,
  isCommandExecutionTool,
  MISSING_COMMAND_FALLBACK,
  selectClientCommandTool,
} from '@/modules/proxy-gateway/antigravity/CommandToolAdapter';

describe('command-tool adapter', () => {
  it('recognizes the supported command-tool labels without case sensitivity', () => {
    for (const name of [
      'shell',
      'bash',
      'local_shell',
      'local_shell_call',
      'PowerShell',
      'pwsh',
      'terminal',
      'cmd',
      'run_command',
      'execute_command',
    ]) {
      expect(isCommandExecutionTool(name)).toBe(true);
    }
    expect(isCommandExecutionTool('search_docs')).toBe(false);
  });

  it('moves the first declared alternate command into the standard command field', () => {
    const result = adaptCommandArguments('PowerShell', {
      cmd: 'Get-ChildItem',
      code: 'Get-Process',
      input: 'Get-Date',
      script: 'Get-Service',
      shell_command: 'Get-Location',
    });

    expect(result).toEqual({
      arguments: {
        code: 'Get-Process',
        command: 'Get-ChildItem',
        input: 'Get-Date',
        script: 'Get-Service',
        shell_command: 'Get-Location',
      },
      fallbackApplied: false,
    });
  });

  it('preserves a non-empty or non-string command exactly as supplied', () => {
    const stringCommand = { command: 'pwd', cmd: 'ignored' };
    const structuredCommand = { command: ['pwd'], cmd: 'also-ignored' };

    expect(adaptCommandArguments('bash', stringCommand)).toEqual({
      arguments: stringCommand,
      fallbackApplied: false,
    });
    expect(adaptCommandArguments('cmd', structuredCommand)).toEqual({
      arguments: structuredCommand,
      fallbackApplied: false,
    });
  });

  it('replaces a blank command with an explicit diagnostic command without claiming success', () => {
    const result = adaptCommandArguments('terminal', {
      command: '   ',
      description: 'sensitive details must not appear in a fallback',
    });

    expect(result).toEqual({
      arguments: {
        command: MISSING_COMMAND_FALLBACK,
        description: 'sensitive details must not appear in a fallback',
      },
      fallbackApplied: true,
    });
    expect(MISSING_COMMAND_FALLBACK).not.toContain('[OK]');
  });

  it('leaves non-command tools untouched', () => {
    const input = { input: 'select * from accounts' };

    expect(adaptCommandArguments('sql_query', input)).toEqual({
      arguments: input,
      fallbackApplied: false,
    });
  });

  it('uses the spelling declared by the client for command tools', () => {
    expect(selectClientCommandTool('PowerShell', new Set(['PwSh']))).toBe('PwSh');
    expect(selectClientCommandTool('CMD', new Set(['Terminal']))).toBe('Terminal');
    expect(selectClientCommandTool('search_docs', new Set(['PwSh']))).toBe('search_docs');
  });
});
