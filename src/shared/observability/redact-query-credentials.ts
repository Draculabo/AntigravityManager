/** Mask credential query values in readable text, including URL-encoded parameter names. */
export function redactQueryCredentials(value: string): string {
  return value.replace(
    /([?&])([^&#\s=]+)=([^&#\s]*)/g,
    (parameter, separator: string, name: string) => {
      const decoded = new URLSearchParams(`${name}=`).keys().next().value;
      return decoded &&
        /^(?:access_token|refresh_token|id_token|api_key|key|client_secret|code)$/iu.test(decoded)
        ? `${separator}${name}=[REDACTED]`
        : parameter;
    },
  );
}
