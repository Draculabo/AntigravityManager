import type { FastifyRequest } from 'fastify';
import type { ImageMonitoringInput, ImageMonitoringRequest } from './image-monitoring-summary';

const IMAGE_FIELD_PATTERN = /^image(?:\d+)?$/u;

function toImageInput(
  data: Buffer,
  filename: string | undefined,
  mimeType: string | undefined,
): ImageMonitoringInput {
  return {
    data: data.toString('base64'),
    filename,
    mimeType: mimeType || 'application/octet-stream',
  };
}

/**
 * Consume a real Fastify multipart stream and retain each file's MIME type.
 *
 * `@Body()` does not parse multipart payloads unless fields are explicitly
 * attached to the request. Streaming the parts also avoids keeping duplicate
 * binary copies in Fastify and the controller.
 */
export async function parseImageMultipartRequest(
  request: FastifyRequest,
): Promise<ImageMonitoringRequest> {
  if (!request.isMultipart()) {
    throw new Error('Expected a multipart/form-data request');
  }

  const body: ImageMonitoringRequest = {};
  const referenceImages: ImageMonitoringInput[] = [];
  let style: string | undefined;
  let imageSize: string | undefined;
  let aspectRatio: string | undefined;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const image = toImageInput(await part.toBuffer(), part.filename, part.mimetype);
      if (part.fieldname === 'image') {
        body.image = image;
      } else if (part.fieldname === 'mask') {
        body.mask = image;
      } else if (
        part.fieldname === 'reference_images' ||
        (IMAGE_FIELD_PATTERN.test(part.fieldname) && part.fieldname !== 'image')
      ) {
        referenceImages.push(image);
      }
      continue;
    }

    const value = String(part.value ?? '');
    switch (part.fieldname) {
      case 'model':
        body.model = value;
        break;
      case 'prompt':
        body.prompt = value;
        break;
      case 'size':
        body.size = value;
        break;
      case 'quality':
        body.quality = value;
        break;
      case 'aspect_ratio':
        aspectRatio = value;
        break;
      case 'image_size':
        imageSize = value;
        break;
      case 'style':
        style = value;
        break;
      default:
        break;
    }
  }

  if (referenceImages.length > 0) {
    body.reference_images = referenceImages;
  }
  if (aspectRatio) {
    body.size = aspectRatio;
  }
  if (imageSize === '4K') {
    body.quality = 'hd';
  } else if (imageSize === '2K') {
    body.quality = 'medium';
  }
  if (style) {
    body.prompt = body.prompt ? `${body.prompt}, style: ${style}` : `style: ${style}`;
  }

  return body;
}
