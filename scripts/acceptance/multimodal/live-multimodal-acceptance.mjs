import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import sharp from 'sharp';

const cases = new Set([
  'chat-image',
  'chat-video',
  'responses-image',
  'gemini-image',
  'gemini-video',
  'anthropic-image',
  'anthropic-video',
  'image-generate',
  'image-edit',
]);
const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures',
  'multimodal',
);
const auditListSchema = z.object({
  items: z.array(z.object({ id: z.string(), timestamp: z.number(), recordKind: z.string() })),
  total: z.number().int(),
});
const auditDetailSchema = z.object({
  request: z.object({
    url: z.string(),
    timestamp: z.number(),
    status: z.number().nullable(),
    outcome: z.string(),
    protocol: z.string(),
    mappedModel: z.string().nullable(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    reasoningTokens: z.number().nullable(),
    responsePartial: z.boolean(),
  }),
  attempts: z.array(z.object({ status: z.number().nullable() })),
});

function options(argv) {
  if (argv.includes('--help')) {
    console.log(
      'Usage: node scripts/acceptance/multimodal/live-multimodal-acceptance.mjs --case CASE --owner cli|electron --gateway http://127.0.0.1:PORT --profile-home PATH --output PATH [--model MODEL]',
    );
    console.log(`Cases: ${[...cases].join(', ')}`);
    process.exit(0);
  }
  const values = {};
  const allowed = new Set(['case', 'owner', 'gateway', 'profile-home', 'output', 'model']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith('--') || !allowed.has(flag.slice(2)) || !argv[index + 1]) {
      throw new Error(`Invalid option: ${flag ?? '(missing)'}`);
    }
    values[flag.slice(2)] = argv[index + 1];
  }
  if (!cases.has(values.case) || !['cli', 'electron'].includes(values.owner)) {
    throw new Error('A supported --case and --owner cli|electron are required');
  }
  let gateway;
  try {
    gateway = new URL(values.gateway);
  } catch {
    throw new Error('--gateway must be a loopback HTTP origin');
  }
  if (
    gateway.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname) ||
    gateway.pathname !== '/' ||
    gateway.search ||
    gateway.hash ||
    gateway.username ||
    gateway.password
  ) {
    throw new Error('--gateway must be a loopback HTTP origin');
  }
  const model =
    values.model ??
    (values.case.startsWith('image-') ? 'gemini-3.1-flash-image' : 'gemini-3.1-pro-high');
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) {
    throw new Error('Invalid --model');
  }
  return {
    caseId: values.case,
    owner: values.owner,
    gateway: gateway.origin,
    profileHome: path.resolve(values['profile-home'] ?? os.homedir()),
    output: path.resolve(values.output ?? 'out/live-multimodal-acceptance'),
    model,
  };
}

async function apiKey(profileHome) {
  if (process.env.AGM_ACCEPTANCE_API_KEY) {
    return process.env.AGM_ACCEPTANCE_API_KEY;
  }
  const config = z
    .object({ proxy: z.object({ api_key: z.string().min(1) }) })
    .parse(
      JSON.parse(
        await fs.readFile(path.join(profileHome, '.antigravity-agent', 'gui_config.json'), 'utf8'),
      ),
    );
  return config.proxy.api_key;
}

export async function evaluateMedia(caseId, body) {
  if (caseId === 'image-generate' || caseId === 'image-edit') {
    const base64 = body?.data?.[0]?.b64_json;
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return { valid: false, outputBytes: 0, observation: 'image data missing' };
    }
    const bytes = Buffer.from(base64, 'base64');
    const signature = bytes.subarray(0, 8).toString('hex');
    const valid =
      signature.startsWith('89504e470d0a1a0a') ||
      signature.startsWith('ffd8ff') ||
      signature.startsWith('52494646');
    if (!valid) {
      return { valid: false, outputBytes: bytes.length, observation: 'unknown image format' };
    }
    try {
      const { data, info } = await sharp(bytes, { limitInputPixels: 16_777_216 })
        .resize(64, 64, { fit: 'inside' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });
      let red = 0;
      let blue = 0;
      for (let index = 0; index < data.length; index += info.channels) {
        const [r, g, b] = data.subarray(index, index + 3);
        red += Number(r > 120 && r > g * 1.3 && r > b * 1.3);
        blue += Number(b > 120 && b > r * 1.3 && b > g * 1.3);
      }
      const pixels = info.width * info.height;
      const colorFractions = { red: red / pixels, blue: blue / pixels };
      const expected = caseId === 'image-edit' ? blue : red;
      const other = caseId === 'image-edit' ? red : blue;
      const colorsValid = expected / pixels >= 0.05 && expected > other * 2;
      return {
        valid: colorsValid,
        outputBytes: bytes.length,
        colorFractions,
        observation: colorsValid ? 'expected image color returned' : 'expected image color missing',
      };
    } catch {
      return { valid: false, outputBytes: bytes.length, observation: 'image decoding failed' };
    }
  }
  let text = '';
  if (caseId.startsWith('chat-')) {
    text = body?.choices?.[0]?.message?.content ?? '';
  } else if (caseId.startsWith('responses-')) {
    text = (body?.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? '')
      .join(' ');
  } else if (caseId.startsWith('gemini-')) {
    text = (body?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join(' ');
  } else {
    text = (body?.content ?? []).map((item) => item.text ?? '').join(' ');
  }
  const normalized = typeof text === 'string' ? text.toLowerCase() : '';
  const valid = caseId.endsWith('video')
    ? /red[\s\S]*blue/.test(normalized)
    : /red/.test(normalized);
  return {
    valid,
    outputBytes: Buffer.byteLength(normalized),
    observation: valid
      ? 'expected colors identified'
      : `expected colors missing (${normalized.slice(0, 120)})`,
  };
}

async function requestFor(caseId, model) {
  const image = (await fs.readFile(path.join(fixtureDir, 'red.png'))).toString('base64');
  const video = caseId.endsWith('video')
    ? (await fs.readFile(path.join(fixtureDir, 'red-then-blue.mp4'))).toString('base64')
    : null;
  const isVideo = caseId.endsWith('video');
  const prompt = isVideo
    ? 'Name the first and last colors visible in this video. Reply using only color names.'
    : 'What is the dominant color in this image? Reply using only the color name.';
  const media = isVideo ? `data:video/mp4;base64,${video}` : `data:image/png;base64,${image}`;
  if (caseId.startsWith('chat-')) {
    return {
      route: '/v1/chat/completions',
      body: {
        model,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              isVideo
                ? { type: 'video_url', video_url: { url: media } }
                : { type: 'image_url', image_url: { url: media } },
            ],
          },
        ],
      },
    };
  }
  if (caseId === 'responses-image') {
    return {
      route: '/v1/responses',
      body: {
        model,
        store: false,
        max_output_tokens: 100,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: media },
            ],
          },
        ],
      },
    };
  }
  if (caseId.startsWith('gemini-')) {
    return {
      route: `/v1beta/models/${model}:generateContent`,
      body: {
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: isVideo ? 'video/mp4' : 'image/png',
                  data: isVideo ? video : image,
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 100 },
      },
    };
  }
  if (caseId.startsWith('anthropic-')) {
    return {
      route: '/v1/messages',
      body: {
        model,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: isVideo ? 'video' : 'image',
                source: {
                  type: 'base64',
                  media_type: isVideo ? 'video/mp4' : 'image/png',
                  data: isVideo ? video : image,
                },
              },
            ],
          },
        ],
      },
    };
  }
  if (caseId === 'image-generate') {
    return {
      route: '/v1/images/generations',
      body: {
        model,
        prompt: 'One solid red square on a plain white background',
        n: 1,
        size: '512x512',
      },
    };
  }
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', 'Make the red square blue while keeping its shape.');
  form.set('image', new Blob([Buffer.from(image, 'base64')], { type: 'image/png' }), 'red.png');
  return { route: '/v1/images/edits', body: form };
}

async function main() {
  const selected = options(process.argv.slice(2));
  const key = await apiKey(selected.profileHome);
  const headers = { authorization: `Bearer ${key}` };
  const getDiagnostic = async (route, schema) => {
    const response = await fetch(`${selected.gateway}${route}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      throw new Error(`Gateway diagnostic failed: ${response.status} ${route.split('?')[0]}`);
    }
    return schema.parse(await response.json());
  };
  await getDiagnostic('/v1/models', z.object({ data: z.array(z.unknown()) }));
  const target = await requestFor(selected.caseId, selected.model);
  const startedAt = Date.now();
  const response = await fetch(`${selected.gateway}${target.route}`, {
    method: 'POST',
    headers:
      target.body instanceof FormData
        ? headers
        : { ...headers, 'content-type': 'application/json' },
    body: target.body instanceof FormData ? target.body : JSON.stringify(target.body),
    signal: AbortSignal.timeout(180000),
  });
  const body = response.ok ? await response.json() : null;
  if (!response.ok) {
    await response.arrayBuffer();
  }
  const endedAt = Date.now();
  await delay(1500);
  const query = new URLSearchParams({
    trafficClass: 'model',
    from: String(startedAt - 2000),
    to: String(endedAt + 2000),
    limit: '200',
    offset: '0',
  });
  const page = await getDiagnostic(`/internal/audit/requests?${query}`, auditListSchema);
  const details = await Promise.all(
    page.items
      .filter((item) => item.recordKind === 'request')
      .map((item) =>
        getDiagnostic(`/internal/audit/requests/${encodeURIComponent(item.id)}`, auditDetailSchema),
      ),
  );
  const matches = details.filter((item) => {
    try {
      return new URL(item.request.url, selected.gateway).pathname === target.route;
    } catch {
      return false;
    }
  });
  const result = response.ok
    ? await evaluateMedia(selected.caseId, body)
    : { valid: false, outputBytes: 0, observation: 'HTTP request failed' };
  const failures = [];
  if (!response.ok) failures.push(`HTTP ${response.status}`);
  if (!result.valid) failures.push(result.observation);
  if (matches.length !== 1)
    failures.push(`Expected one matching audit request, found ${matches.length}`);
  if (
    matches.some((item) => item.request.status !== response.status || item.request.responsePartial)
  )
    failures.push('Audit status or completion mismatch');
  const report = {
    schemaVersion: 1,
    platform: process.platform,
    ownerDeclared: selected.owner,
    caseId: selected.caseId,
    model: selected.model,
    route: target.route,
    startedAt,
    durationMs: endedAt - startedAt,
    httpStatus: response.status,
    outputBytes: result.outputBytes,
    observation: result.observation,
    colorFractions: result.colorFractions ?? null,
    audit: matches.map((item) => ({
      protocol: item.request.protocol,
      status: item.request.status,
      outcome: item.request.outcome,
      mappedModel: item.request.mappedModel,
      inputTokens: item.request.inputTokens,
      outputTokens: item.request.outputTokens,
      reasoningTokens: item.request.reasoningTokens,
      responsePartial: item.request.responsePartial,
      attemptStatuses: item.attempts.map((attempt) => attempt.status),
    })),
    auditPageTruncated: page.total > page.items.length,
    verdict: { passed: failures.length === 0, failures },
  };
  if (report.auditPageTruncated) {
    report.verdict = {
      passed: false,
      failures: [...failures, 'Audit page truncated; rerun without concurrent traffic'],
    };
  }
  await fs.mkdir(selected.output, { recursive: true, mode: 0o700 });
  const reportPath = path.join(
    selected.output,
    `${selected.caseId}-${selected.owner}-${Date.now()}.json`,
  );
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      reportPath,
      passed: report.verdict.passed,
      failures: report.verdict.failures,
      httpStatus: response.status,
    }),
  );
  if (!report.verdict.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Multimodal acceptance failed');
    process.exitCode = 1;
  });
}
