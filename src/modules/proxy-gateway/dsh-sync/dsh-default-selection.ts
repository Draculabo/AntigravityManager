import { isMap, type Document } from 'yaml';
import { z } from 'zod';
import { DshOwnerError } from './dsh-owner.error';

const selection = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
}).catchall(z.json());
export const DshDefaultReceiptSchema = z.strictObject({
  entryId: z.string().nullable(),
  entryName: z.string().nullable(),
  previous: selection,
  applied: selection,
});
type Receipt = z.infer<typeof DshDefaultReceiptSchema>;
const entryList = z.array(z.object({
  id: z.string().optional(), name: z.string().optional(), config: z.unknown().optional(),
}).passthrough());

export function planDshDefaultSelection(input: {
  document: Document;
  action: 'sync' | 'remove';
  activateModel: string | null;
  models: string[];
  previousReceipt: Receipt | null;
  providerId?: string;
}) {
  const providerId = input.providerId ?? 'antigravity-manager';
  const entries = entryList.safeParse(input.document.toJS());
  if (!entries.success) {
    throw new DshOwnerError('invalid-config');
  }
  const matches = entries.data.flatMap((entry, index) =>
    entry.id === 'agent-default-model' || entry.name === '@deepseek-ai/dsh-agent-default-model' ? [{ entry, index }] : [],
  );
  const match = matches[0];
  if (matches.length > 1) {
    throw new DshOwnerError('invalid-config');
  }
  if (!match) {
    if (input.activateModel || input.previousReceipt) {
      throw new DshOwnerError('invalid-config');
    }
    return { receipt: null, changed: false, action: 'preserve' as const, model: null };
  }
  const parsed = selection.safeParse(match.entry.config);
  if (!parsed.success || !isMap(input.document.getIn([match.index, 'config'], true))) {
    if (input.activateModel || input.previousReceipt) {
      throw new DshOwnerError('invalid-config');
    }
    return { receipt: null, changed: false, action: 'preserve' as const, model: null };
  }
  const current = parsed.data;
  const previous = input.previousReceipt;
  const owned = previous !== null
    && previous.entryId === (match.entry.id ?? null)
    && previous.entryName === (match.entry.name ?? null)
    && JSON.stringify(previous.applied) === JSON.stringify(current);
  if (input.action === 'remove') {
    if (owned) {
      input.document.setIn([match.index, 'config'], previous.previous);
      return { receipt: null, changed: true, action: 'restore' as const, model: previous.previous.model };
    }
    if (current.provider === providerId) {
      throw new DshOwnerError('conflict');
    }
    return { receipt: null, changed: false, action: 'preserve' as const, model: current.model };
  }
  if (!input.activateModel) {
    if (current.provider === providerId && !input.models.includes(current.model)) {
      throw new DshOwnerError('conflict');
    }
    return { receipt: owned ? previous : null, changed: false, action: 'preserve' as const, model: current.model };
  }
  const { reasoningEffort: _previousEffort, ...retained } = current;
  const applied = { ...retained, provider: providerId, model: input.activateModel };
  const changed = JSON.stringify(applied) !== JSON.stringify(current);
  if (changed) {
    input.document.setIn([match.index, 'config'], applied);
  }
  return {
    receipt: { entryId: match.entry.id ?? null, entryName: match.entry.name ?? null, previous: owned ? previous.previous : current, applied },
    changed, action: 'activate' as const, model: input.activateModel,
  };
}
