import { createLocalAccountImportRouter } from '../transport.router';
import { selectedLocalImportOwner } from './selected-owner';
export const localAccountImportRouter = createLocalAccountImportRouter(selectedLocalImportOwner);
