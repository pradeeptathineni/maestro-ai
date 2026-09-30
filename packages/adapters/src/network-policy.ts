import { lookup as systemLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export class NetworkPolicyError extends Error {
  constructor(readonly code: 'invalid_url' | 'blocked_destination' | 'unapproved_host') {
    super(code);
    this.name = 'NetworkPolicyError';
  }
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function inRange(address: number, base: string, bits: number): boolean {
  const baseNumber = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

export function isReservedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = ipv4Number(normalized.replace(/^::ffff:/, ''));
  if (ipv4 !== null) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => inRange(ipv4, base as string, bits as number));
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

export function createPublicNetworkLookup(resolver: LookupFunction = systemLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, { ...options, all: true }, (error, value, family) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const addresses: LookupAddress[] = Array.isArray(value)
        ? value
        : [{ address: value, family: family ?? isIP(value) }];
      if (!addresses.length || addresses.some((address) => isReservedAddress(address.address))) {
        callback(new NetworkPolicyError('blocked_destination'), '', 0);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

const publicNetworkDispatcher = new Agent({
  connect: { lookup: createPublicNetworkLookup() },
  maxOrigins: 2,
  maxResponseSize: 524_288,
});

export function fetchFixedPublicResource(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return undiciFetch(input, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: publicNetworkDispatcher,
  }) as unknown as Promise<Response>;
}

export function validateFixedPublicUrl(value: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetworkPolicyError('invalid_url');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    isReservedAddress(host)
  ) {
    throw new NetworkPolicyError('blocked_destination');
  }
  if (!allowedHosts.map((item) => item.toLowerCase()).includes(host)) {
    throw new NetworkPolicyError('unapproved_host');
  }
  return url;
}

export function validateExplicitLocalEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NetworkPolicyError('invalid_url');
  }
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !allowed.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new NetworkPolicyError('blocked_destination');
  }
  return url;
}

export async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new RangeError('response_too_large');
  }
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maximumBytes) throw new RangeError('response_too_large');
    return { text, bytes };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError('response_too_large');
    }
    chunks.push(decoder.decode(chunk.value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(''), bytes };
}
