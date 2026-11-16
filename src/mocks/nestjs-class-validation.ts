export class ValidationPipe {
  constructor() {
    throw new Error('Standalone Core validates requests with Zod');
  }
}

export class ClassSerializerInterceptor {
  constructor() {
    throw new Error('Standalone Core does not use class-based response serialization');
  }
}
