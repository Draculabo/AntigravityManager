export interface CredentialReadbackMatches {
  accessToken?: boolean;
  refreshToken?: boolean;
  idToken?: boolean;
  expiry?: boolean;
  projectId?: boolean;
}

/** A readback failure carries equality results only, never expected or stored credentials. */
export class CredentialReadbackError extends Error {
  readonly code = 'credential-readback-mismatch';
  readonly matches: CredentialReadbackMatches;
  constructor(message: string, matches: CredentialReadbackMatches) {
    super(message);
    this.name = 'CredentialReadbackError';
    this.matches = matches;
  }
}
