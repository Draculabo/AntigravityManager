import type { KoffiFunc } from 'koffi';
import { isEqual } from 'lodash-es';
import { z } from 'zod';

export const LinuxIdeCredentialSnapshotSchema = z
  .array(
    z.strictObject({
      path: z
        .string()
        .max(4096)
        .regex(/^\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/),
      payload: z
        .base64()
        .max(90000)
        .refine((value) => Buffer.from(value, 'base64').length <= 65536),
      contentType: z.string().min(1).max(256),
    }),
  )
  .max(64)
  .refine((items) => new Set(items.map((item) => item.path)).size === items.length);
export type LinuxIdeCredentialSnapshot = z.infer<typeof LinuxIdeCredentialSnapshotSchema>;

type NativeCall = KoffiFunc<(...args: unknown[]) => unknown>;
class LinuxIdeCredentialError extends Error {}
const PointerSchema = z.bigint().refine((value) => value !== 0n);
const ListSchema = z.object({ data: PointerSchema, next: z.bigint().nullable() });
// GLib registers process-wide types whose function pointers outlive each operation.
// Unloading libsecret and loading it again attempts to register those types twice.
const nativeLibraries = new Map<string, ReturnType<typeof import('koffi').load>>();

/** libsecret searches every collection; updating existing items preserves their attributes/labels.
 * The native keyring binding cannot distinguish duplicate service/username items across collections.
 */
async function withSecretService<T>(
  operation: (session: {
    read: () => Promise<LinuxIdeCredentialSnapshot>;
    write: (payload: Buffer) => Promise<void>;
    restore: (saved: LinuxIdeCredentialSnapshot) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  if (process.platform !== 'linux') {
    throw new LinuxIdeCredentialError('Linux IDE credentials require Linux Secret Service');
  }
  const koffi = await import('koffi');
  const load = (name: string) => {
    const existing = nativeLibraries.get(name);
    if (existing) {
      return existing;
    }
    const library = koffi.load(name);
    nativeLibraries.set(name, library);
    return library;
  };
  let release: (() => void) | undefined;
  try {
    const secret = load('libsecret-1.so.0');
    const glib = load('libglib-2.0.so.0');
    const objects = load('libgobject-2.0.so.0');
    const gio = load('libgio-2.0.so.0');
    const bind = (library: typeof secret, signature: string): NativeCall => library.func(signature);
    const unref = bind(objects, 'void g_object_unref(void *value)');
    const cancel = bind(gio, 'void g_cancellable_cancel(void *value)');
    const cancellation = PointerSchema.parse(bind(gio, 'void *g_cancellable_new(void)')());
    const timer = setTimeout(() => cancel(cancellation), 10000);
    let service: bigint | undefined;
    let attributes: bigint | undefined;
    const items: bigint[] = [];
    const strings: Buffer[] = [];
    let list: bigint | null = null;
    const listType = koffi.struct({ data: 'void *', next: 'void *', prev: 'void *' });
    const tableUnref = bind(glib, 'void g_hash_table_unref(void *table)');
    const listFree = bind(glib, 'void g_list_free_full(void *list, void *destroy)');
    release = () => {
      clearTimeout(timer);
      if (list) {
        listFree(list, objects.symbol('g_object_unref', 'uint8_t'));
      }
      if (attributes) {
        tableUnref(attributes);
      }
      for (const value of strings) {
        value.fill(0);
      }
      if (service) {
        unref(service);
      }
      unref(cancellation);
    };
    const errorFree = bind(glib, 'void g_error_free(void *error)');
    const call = (fn: NativeCall, args: unknown[]): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const nativeError: (bigint | null)[] = [null];
        fn.async(...args.slice(0, -1), nativeError, (error: Error | null, value: unknown) => {
          if (nativeError[0]) {
            errorFree(nativeError[0]);
          }
          if (error || nativeError[0]) {
            reject(new LinuxIdeCredentialError('Linux Secret Service operation failed'));
          } else {
            resolve(value);
          }
        });
      });
    service = PointerSchema.parse(
      await call(
        bind(secret, 'void *secret_service_get_sync(int flags, void *cancel, _Out_ void **error)'),
        [2, cancellation, null],
      ),
    );
    attributes = PointerSchema.parse(
      bind(glib, 'void *g_hash_table_new(void *hash, void *equal)')(
        glib.symbol('g_str_hash', 'uint8_t'),
        glib.symbol('g_str_equal', 'uint8_t'),
      ),
    );
    const insert = bind(glib, 'int g_hash_table_insert(void *table, void *key, void *value)');
    strings.push(
      ...['service', 'gemini', 'username', 'antigravity'].map((value) => Buffer.from(`${value}\0`)),
    );
    insert(attributes, strings[0], strings[1]);
    insert(attributes, strings[2], strings[3]);
    // ALL | LOAD_SECRETS; locked items fail preflight instead of opening an unlock prompt.
    const found = await call(
      bind(
        secret,
        'void *secret_service_search_sync(void *service, void *schema, void *attributes, int flags, void *cancel, _Out_ void **error)',
      ),
      [service, null, attributes, 10, cancellation, null],
    );
    list = found === null ? null : PointerSchema.parse(found);
    let cursor = list;
    const seen = new Set<bigint>();
    while (cursor) {
      if (seen.has(cursor) || seen.size >= 64) {
        throw new LinuxIdeCredentialError('Linux IDE credential search exceeds the recovery limit');
      }
      seen.add(cursor);
      const row = ListSchema.parse(koffi.decode(cursor, listType));
      items.push(row.data);
      cursor = row.next;
    }
    const itemPath = bind(gio, 'str g_dbus_proxy_get_object_path(void *item)');
    const valueGet = bind(secret, 'void *secret_item_get_secret(void *item)');
    const valueBytes = bind(secret, 'void *secret_value_get(void *value, _Out_ size_t *length)');
    const valueType = bind(secret, 'str secret_value_get_content_type(void *value)');
    const valueUnref = bind(secret, 'void secret_value_unref(void *value)');
    const valueNew = bind(secret, 'void *secret_value_new(void *data, intptr_t length, str type)');
    const pathOf = (item: bigint) => z.string().parse(itemPath(item));
    const set = async (item: bigint, bytes: Buffer, contentType: string) => {
      const value = PointerSchema.parse(valueNew(bytes, bytes.length, contentType));
      try {
        const ok = await call(
          bind(
            secret,
            'int secret_item_set_secret_sync(void *item, void *value, void *cancel, _Out_ void **error)',
          ),
          [item, value, cancellation, null],
        );
        if (ok !== 1) {
          throw new LinuxIdeCredentialError('Linux IDE credential write failed');
        }
      } finally {
        valueUnref(value);
      }
    };
    const read = async (): Promise<LinuxIdeCredentialSnapshot> => {
      const snapshot = items.map((item) => {
        const value = PointerSchema.parse(valueGet(item));
        try {
          const length = [0];
          const bytes = valueBytes(value, length);
          const count = z.number().int().min(0).max(65536).parse(length[0]);
          const data: unknown = count ? koffi.decode(bytes, 'uint8_t', count) : new Uint8Array();
          const parsed = z
            .union([z.instanceof(Uint8Array), z.array(z.number().int().min(0).max(255))])
            .parse(data);
          return {
            path: pathOf(item),
            payload: Buffer.from(parsed).toString('base64'),
            contentType: z.string().parse(valueType(value)),
          };
        } finally {
          valueUnref(value);
        }
      });
      return LinuxIdeCredentialSnapshotSchema.parse(
        snapshot.sort((a, b) => a.path.localeCompare(b.path)),
      );
    };
    return await operation({
      read,
      write: async (bytes) => {
        if (items.length) {
          for (const item of items) {
            await set(item, bytes, 'text/plain');
          }
        } else {
          const value = PointerSchema.parse(valueNew(bytes, bytes.length, 'text/plain'));
          try {
            const ok = await call(
              bind(
                secret,
                'int secret_service_store_sync(void *service, void *schema, void *attributes, str collection, str label, void *value, void *cancel, _Out_ void **error)',
              ),
              [service, null, attributes, null, 'Antigravity', value, cancellation, null],
            );
            if (ok !== 1) {
              throw new LinuxIdeCredentialError('Linux IDE credential creation failed');
            }
          } finally {
            valueUnref(value);
          }
        }
      },
      restore: async (saved) => {
        if (saved.some((entry) => !items.some((item) => pathOf(item) === entry.path))) {
          throw new LinuxIdeCredentialError(
            'Linux IDE recovery item was removed outside this switch',
          );
        }
        for (const item of items) {
          const entry = saved.find((candidate) => candidate.path === pathOf(item));
          if (entry) {
            await set(item, Buffer.from(entry.payload, 'base64'), entry.contentType);
          } else {
            const ok = await call(
              bind(
                secret,
                'int secret_item_delete_sync(void *item, void *cancel, _Out_ void **error)',
              ),
              [item, cancellation, null],
            );
            if (ok !== 1) {
              throw new LinuxIdeCredentialError('Linux IDE credential recovery deletion failed');
            }
          }
        }
      },
    });
  } catch (error) {
    if (error instanceof LinuxIdeCredentialError) {
      throw error;
    }
    throw new LinuxIdeCredentialError(
      'Linux IDE Secret Service access failed; credentials may be partially updated',
    );
  } finally {
    release?.();
  }
}

export async function readLinuxIdeCredentialSnapshot(): Promise<LinuxIdeCredentialSnapshot> {
  return withSecretService((session) => session.read());
}

export async function writeLinuxIdeCredentialPayload(payload: string): Promise<void> {
  await withSecretService((session) => session.write(Buffer.from(payload, 'utf8')));
  const readback = await readLinuxIdeCredentialSnapshot();
  if (
    !readback.length ||
    readback.some((entry) => entry.payload !== Buffer.from(payload).toString('base64'))
  ) {
    throw new LinuxIdeCredentialError(
      'Linux IDE credential write could not be confirmed in every collection',
    );
  }
}

export async function restoreLinuxIdeCredentialSnapshot(
  saved: LinuxIdeCredentialSnapshot,
): Promise<void> {
  await withSecretService((session) => session.restore(saved));
  if (!isEqual(await readLinuxIdeCredentialSnapshot(), saved)) {
    throw new LinuxIdeCredentialError('Linux IDE credential recovery could not be confirmed');
  }
}
