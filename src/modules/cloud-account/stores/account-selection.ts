import { createStore } from 'zustand/vanilla';

export interface AccountSelectionState {
  selectedIds: ReadonlySet<string>;
  setSelected: (id: string, selected: boolean) => void;
  toggleVisible: (visibleIds: readonly string[]) => void;
  clear: () => void;
}

export function getSelectedVisibleAccountIds(
  selectedIds: ReadonlySet<string>,
  visibleIds: readonly string[],
) {
  // Preserve selection order while excluding accounts hidden by the current filter.
  const visible = new Set(visibleIds);
  return Array.from(selectedIds).filter((id) => visible.has(id));
}

export function createAccountSelectionStore() {
  return createStore<AccountSelectionState>()((set) => ({
    selectedIds: new Set(),
    setSelected: (id, selected) => {
      set((state) => {
        if (state.selectedIds.has(id) === selected) {
          return state;
        }
        const selectedIds = new Set(state.selectedIds);
        if (selected) {
          selectedIds.add(id);
        } else {
          selectedIds.delete(id);
        }
        return { selectedIds };
      });
    },
    toggleVisible: (visibleIds) => {
      set((state) => ({
        selectedIds:
          visibleIds.length > 0 && visibleIds.every((id) => state.selectedIds.has(id))
            ? new Set()
            : new Set(visibleIds),
      }));
    },
    clear: () => {
      set((state) => (state.selectedIds.size === 0 ? state : { selectedIds: new Set() }));
    },
  }));
}

export type AccountSelectionStore = ReturnType<typeof createAccountSelectionStore>;
