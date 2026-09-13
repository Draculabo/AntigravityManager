import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_GENERATION_BODY_BYTES } from '@/modules/proxy-gateway/server/modules/openai/media/image-input-validation';
import { registerImageGenerationBodyLimit } from '@/server/main';

describe('image generation route body limit', () => {
  it('raises only the JSON image-generation route ceiling', () => {
    let onRoute:
      | ((options: { bodyLimit?: number; method: string; url: string }) => void)
      | undefined;
    registerImageGenerationBodyLimit({
      addHook: (_name, handler) => {
        onRoute = handler as typeof onRoute;
      },
    });

    const imageRoute = { bodyLimit: 1024, method: 'POST', url: '/v1/images/generations' };
    const chatRoute = { bodyLimit: 1024, method: 'POST', url: '/v1/chat/completions' };
    onRoute?.(imageRoute);
    onRoute?.(chatRoute);

    expect(imageRoute.bodyLimit).toBe(MAX_IMAGE_GENERATION_BODY_BYTES);
    expect(chatRoute.bodyLimit).toBe(1024);
  });
});
