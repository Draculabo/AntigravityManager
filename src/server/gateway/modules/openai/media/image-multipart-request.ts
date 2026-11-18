import type { FastifyRequest } from 'fastify';
import type { ImageMonitoringInput, ImageMonitoringRequest } from './image-monitoring-summary';
import { validateInputImageLimits } from './image-input-validation';
import { validatedImageMimeType } from '../../../common/image-content-validation';

const IMAGE_FIELD_PATTERN = /^image\d+$/u;
const MAX_IMAGE_MULTIPART_FILE_PARTS = 64;

export function isEditImageField(name: string): boolean {
  return name === 'image' || name === 'image[]' || IMAGE_FIELD_PATTERN.test(name);
}

function toImageInput(data: Buffer, filename: string | undefined): ImageMonitoringInput {
  return {
    data: data.toString('base64'),
    filename,
    mimeType: validatedImageMimeType(data),
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
  const inputImages: ImageMonitoringInput[] = [];
  let totalInputImageBytes = 0;
  for await (const part of request.parts({ limits: { files: MAX_IMAGE_MULTIPART_FILE_PARTS } })) {
    if (part.type === 'file') {
      const isImage = isEditImageField(part.fieldname);
      const isMask = part.fieldname === 'mask';
      if (!isImage && !isMask) {
        part.file.resume();
        continue;
      }

      const bytes = await part.toBuffer();
      if (isImage) {
        const nextTotal = totalInputImageBytes + bytes.length;
        validateInputImageLimits(inputImages.length + 1, bytes.length, nextTotal);
        totalInputImageBytes = nextTotal;
        inputImages.push(toImageInput(bytes, part.filename));
      } else {
        const nextTotal = totalInputImageBytes + bytes.length;
        validateInputImageLimits(inputImages.length, bytes.length, nextTotal);
        totalInputImageBytes = nextTotal;
        body.mask = toImageInput(bytes, part.filename);
      }
      continue;
    }

    const value = String(part.value ?? '');
    switch (part.fieldname) {
      case 'model':
        if (value) {
          body.model = value;
        }
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
        body.aspect_ratio = value;
        break;
      case 'image_size':
      case 'imageSize':
        body.image_size = value;
        break;
      case 'style':
        body.style = value;
        break;
      default:
        break;
    }
  }

  if (inputImages.length === 1) {
    body.image = inputImages[0];
  } else if (inputImages.length > 1) {
    body.image = inputImages;
  }
  return body;
}
