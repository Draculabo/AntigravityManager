const gatewaySessionKey = /^session:(?:store:v2|affinity:v1):([a-f0-9]{12})[a-f0-9]{52}$/u;

export function shortGatewaySessionId(key: string) {
  return gatewaySessionKey.exec(key)?.[1];
}
