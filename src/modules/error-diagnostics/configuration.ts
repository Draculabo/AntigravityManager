/** Renderer-safe public configuration contract; no process or filesystem imports. */
export { ErrorDiagnosticsConfigSchema, type ErrorDiagnosticsConfig } from './error-settings';
export {
  ErrorWindowBudgetSchema,
  resolveErrorWindowBudget,
  type ErrorWindowBudget,
} from './error-budget';
