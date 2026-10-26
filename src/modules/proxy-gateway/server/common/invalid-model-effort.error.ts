import { BadRequestException } from '@nestjs/common';

export class InvalidModelEffortError extends BadRequestException {
  constructor(readonly effort: string) {
    super(
      `Unsupported model effort "${effort}". Use extra_low, min, minimal, lite, low, medium, high, x_high, xhigh, max, or extreme.`,
    );
    this.name = 'InvalidModelEffortError';
  }
}
