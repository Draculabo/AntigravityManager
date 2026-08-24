import { HttpStatus } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { forEach } from 'lodash-es';

export interface LocalResourceErrorResponse {
  statusCode: number;
  body: unknown;
}

export interface LocalResourceReply<TBody> {
  body: TBody;
  headers?: Record<string, string>;
}

export interface LocalResourcePage<TResource> {
  resources: TResource[];
  hasMore: boolean;
  nextPageToken?: string;
}

interface LocalResourceOperations<TResource, TContent, TCreateInput> {
  create(input: TCreateInput): Promise<TResource>;
  list(options: {
    limit?: number;
    pageToken?: string;
  }): Promise<{ resources: TResource[]; nextPageToken?: string }>;
  stat(handle: string): Promise<TResource>;
  content(handle: string): Promise<{ resource: TResource; content: TContent }>;
  remove(handle: string): Promise<boolean>;
  resolveHandle(value: string): string | null;
  notFound(value: string): Error;
}

/**
 * Owns the protocol-neutral controller flow for one local resource capability.
 * Resource shapes, validation rules, and error envelopes remain in the caller.
 */
export class LocalResourceControllerKernel<TResource, TContent, TCreateInput> {
  constructor(
    private readonly operations: LocalResourceOperations<TResource, TContent, TCreateInput>,
  ) {}

  public create(input: TCreateInput): Promise<TResource> {
    return this.operations.create(input);
  }

  public async list(limit?: string, pageToken?: string): Promise<LocalResourcePage<TResource>> {
    const result = await this.operations.list({
      limit: limit ? Number(limit) : undefined,
      pageToken,
    });
    return {
      resources: result.resources,
      hasMore: Boolean(result.nextPageToken),
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    };
  }

  public stat(value: string): Promise<TResource> {
    return this.operations.stat(this.requireHandle(value));
  }

  public content(value: string): Promise<{ resource: TResource; content: TContent }> {
    return this.operations.content(this.requireHandle(value));
  }

  public async remove(value: string): Promise<string> {
    const handle = this.requireHandle(value);
    if (!(await this.operations.remove(handle))) {
      throw this.operations.notFound(value);
    }
    return handle;
  }

  public async respond<TBody>(
    res: FastifyReply,
    operation: () => Promise<LocalResourceReply<TBody>>,
    toErrorResponse: (error: unknown) => LocalResourceErrorResponse,
    normalizeError?: (error: unknown) => unknown,
  ): Promise<void> {
    try {
      const response = await operation();
      if (response.headers) {
        forEach(response.headers, (value, name) => {
          res.header(name, value);
        });
      }
      res.status(HttpStatus.OK).send(response.body);
    } catch (error) {
      const response = toErrorResponse(normalizeError ? normalizeError(error) : error);
      res.status(response.statusCode).send(response.body);
    }
  }

  private requireHandle(value: string): string {
    const handle = this.operations.resolveHandle(value);
    if (!handle) {
      throw this.operations.notFound(value);
    }
    return handle;
  }
}
