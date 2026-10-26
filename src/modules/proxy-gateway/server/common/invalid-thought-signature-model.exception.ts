import { BadRequestException } from '@nestjs/common';

export type ThoughtSignatureTargetFamily = 'claude' | 'gemini' | 'unknown';

export class InvalidThoughtSignatureModelError extends BadRequestException {
  constructor(position: string, family: ThoughtSignatureTargetFamily) {
    super(
      `Thought signature format at ${position} is incompatible with target model family ${family}.`,
    );
  }
}
