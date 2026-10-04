import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { evaluateMedia } from './live-multimodal-acceptance.mjs';

async function image(background) {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background } })
    .png()
    .toBuffer();
  return { data: [{ b64_json: bytes.toString('base64') }] };
}
test('generation and editing require the requested color, not just valid image bytes', async () => {
  const red = await image('red');
  const blue = await image('blue');
  assert.equal((await evaluateMedia('image-generate', red)).valid, true);
  assert.equal((await evaluateMedia('image-generate', blue)).valid, false);
  assert.equal((await evaluateMedia('image-edit', blue)).valid, true);
  assert.equal((await evaluateMedia('image-edit', red)).valid, false);
});
test('truncated image bytes fail even when they contain a PNG signature', async () => {
  assert.deepEqual(
    await evaluateMedia('image-edit', {
      data: [{ b64_json: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }],
    }),
    { valid: false, outputBytes: 8, observation: 'image decoding failed' },
  );
});
test('video recognition checks color order and image recognition checks the fixture color', async () => {
  assert.equal(
    (await evaluateMedia('chat-video', { choices: [{ message: { content: 'red, blue' } }] })).valid,
    true,
  );
  assert.equal(
    (await evaluateMedia('chat-video', { choices: [{ message: { content: 'blue, red' } }] })).valid,
    false,
  );
  assert.equal(
    (await evaluateMedia('anthropic-image', { content: [{ text: 'green' }] })).valid,
    false,
  );
});
