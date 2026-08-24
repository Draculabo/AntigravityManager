import { Inject, Injectable } from '@nestjs/common';

import { LocalResourceControllerKernel } from '../../common/local-resource/local-resource-controller.kernel';
import { FileContentStore } from './file-content-store.service';
import {
  FileStoreError,
  parseFileHandle,
  type PutFileInput,
  type StoredFileRecord,
} from './file-store.types';

@Injectable()
export class FileResourceKernel extends LocalResourceControllerKernel<
  StoredFileRecord,
  Buffer,
  PutFileInput
> {
  constructor(@Inject(FileContentStore) store: FileContentStore) {
    super({
      create: (input) => store.put(input),
      list: async (options) => {
        const result = await store.list(options);
        return {
          resources: result.files,
          ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
        };
      },
      stat: (handle) => store.stat(handle),
      content: async (handle) => {
        const result = await store.get(handle);
        return { resource: result.record, content: result.bytes };
      },
      remove: (handle) => store.delete(handle),
      resolveHandle: parseFileHandle,
      notFound: FileStoreError.notFound,
    });
  }
}
