import { NotFoundException } from '@nestjs/common';

export class RetiredModelError extends NotFoundException {
  constructor(model: string) {
    super(`Model "${model}" is no longer available.`);
  }
}
