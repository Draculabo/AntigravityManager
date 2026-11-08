import { BadRequestException } from '@nestjs/common';
import type { Message, ToolResultBlock, ToolUseBlock } from './types';

type AssociationFailure =
  | 'duplicate-pending-id'
  | 'missing-pending-call'
  | 'invalid-role'
  | 'ambiguous-cached-call'
  | 'ambiguous-missing-id'
  | 'conflicting-result-name'
  | 'conflicting-item-id';

export class InvalidToolResultAssociationError extends BadRequestException {
  constructor(
    position: string,
    readonly reason: AssociationFailure,
  ) {
    // Positions are sufficient to locate the invalid history without exposing tool data.
    super(`Invalid tool history at ${position}: ${reason}.`);
  }
}

/** A result consumes its preceding call; completed IDs can be reused in a later round. */
export class ClaudeToolResultAssociation {
  private readonly pending = new Map<string, string>();

  add(block: ToolUseBlock, role: Message['role'], position: string): void {
    if (role !== 'assistant') {
      throw new InvalidToolResultAssociationError(position, 'invalid-role');
    }
    if (this.pending.has(block.id)) {
      throw new InvalidToolResultAssociationError(position, 'duplicate-pending-id');
    }
    this.pending.set(block.id, block.name);
  }

  consume(block: ToolResultBlock, role: Message['role'], position: string): string {
    if (role !== 'user') {
      throw new InvalidToolResultAssociationError(position, 'invalid-role');
    }
    const name = this.pending.get(block.tool_use_id);
    if (name === undefined) {
      throw new InvalidToolResultAssociationError(position, 'missing-pending-call');
    }
    this.pending.delete(block.tool_use_id);
    return name;
  }
}

/** Admission runs before leasing; the mapper repeats it for direct conversion callers. */
export function validateClaudeToolResultAssociations(messages: Message[]): void {
  const association = new ClaudeToolResultAssociation();
  for (const [messageIndex, message] of messages.entries()) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const [blockIndex, block] of message.content.entries()) {
      const position = `messages[${messageIndex}].content[${blockIndex}]`;
      if (block.type === 'tool_use') {
        association.add(block, message.role, position);
      } else if (block.type === 'tool_result') {
        association.consume(block, message.role, position);
      }
    }
  }
}
