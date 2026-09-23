export type CurlShell = 'posix' | 'powershell';

export interface CurlRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

const OMIT_HEADERS = new Set(['connection', 'content-length', 'host', 'transfer-encoding']);

function quote(value: string, shell: CurlShell): string {
  return shell === 'powershell'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Pure request-to-command conversion; the caller owns credential selection and clipboard access. */
export function formatCurlRequest(request: CurlRequest, shell: CurlShell): string {
  if (/[\r\n]/u.test(request.method + request.url)) {
    throw new Error('The request method or URL contains a line break');
  }
  const command = shell === 'powershell' ? 'curl.exe' : 'curl';
  const args = [
    command,
    '-X',
    quote(request.method.toUpperCase(), shell),
    quote(request.url, shell),
  ];
  for (const [name, value] of Object.entries(request.headers)) {
    if (/[\r\n]/u.test(name + value)) {
      throw new Error('A request header contains a line break');
    }
    if (OMIT_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    args.push('-H', quote(`${name}: ${value}`, shell));
  }
  if (request.body !== undefined) {
    args.push('--data-raw', quote(request.body, shell));
  }
  return args.join(' ');
}
