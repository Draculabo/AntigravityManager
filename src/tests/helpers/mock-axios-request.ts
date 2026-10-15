import axios, { AxiosHeaders, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { vi } from 'vitest';
import type { Agent } from 'node:http';

export interface MockHttpResponse {
  json?: () => Promise<unknown>;
  ok?: boolean;
  status?: number;
  text?: () => Promise<string>;
}

export interface MockHttpRequestOptions {
  body?: unknown;
  headers?: AxiosRequestConfig['headers'];
  method?: string;
  proxy?: AxiosRequestConfig['proxy'];
  httpAgent?: Agent;
  httpsAgent?: Agent;
  signal?: AxiosRequestConfig['signal'];
}

export type MockHttpTransport = (
  url: string,
  options: MockHttpRequestOptions,
) => Promise<MockHttpResponse>;

/** Maps a deterministic test transport onto Axios without involving a real network adapter. */
export function mockAxiosRequests(transport: MockHttpTransport) {
  return vi.spyOn(axios, 'request').mockImplementation(async (config) => {
    const response = await transport(config.url ?? '', {
      body: config.data,
      headers: config.headers,
      method: config.method,
      proxy: config.proxy,
      httpAgent: config.httpAgent,
      httpsAgent: config.httpsAgent,
      signal: config.signal,
    });
    const data = response.json
      ? await response.json()
      : response.text
        ? await response.text()
        : undefined;

    const axiosResponse: AxiosResponse<unknown> = {
      config: {
        headers: new AxiosHeaders(),
      },
      data,
      headers: {},
      status: response.status ?? (response.ok === false ? 500 : 200),
      statusText: '',
    };

    return axiosResponse;
  });
}
