/** Main/core composition contract. Renderer consumers use configuration.ts only. */
export { errorProcessOwner } from './error-process-owner';
export { errorDiagnosticOwner, type ErrorDiagnosticOperations } from './error-owner.service';
export { createErrorDiagnosticRouter } from './error-owner.router';
export { createErrorDiagnosticClient } from './error-owner.client';
export { selectErrorDiagnosticOwner } from './desktop-adapter';
