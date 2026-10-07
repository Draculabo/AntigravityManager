// Keep diagnostics in the isolated fixture instead of opening the user's production log directory.
export const logger = { warn: (message: string) => console.warn(message) };
