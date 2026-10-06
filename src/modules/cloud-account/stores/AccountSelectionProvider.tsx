import { createContext, useContext, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createAccountSelectionStore, type AccountSelectionStore } from './account-selection';

const AccountSelectionContext = createContext<AccountSelectionStore | null>(null);

export function AccountSelectionProvider({ children }: { children: ReactNode }) {
  // A mounted account page owns its selection; other pages and later visits start empty.
  const [store] = useState(createAccountSelectionStore);
  return <AccountSelectionContext value={store}>{children}</AccountSelectionContext>;
}

export function useAccountSelectionStore() {
  const store = useContext(AccountSelectionContext);
  if (!store) {
    throw new Error('Account selection must be used within its page provider.');
  }
  return store;
}

export function useAccountSelection<T>(
  selector: (state: ReturnType<AccountSelectionStore['getState']>) => T,
) {
  return useStore(useAccountSelectionStore(), selector);
}
