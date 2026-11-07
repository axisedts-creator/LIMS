import 'server-only';
import { headers } from 'next/headers';
import { decodeSession, H_ACCESS_TOKEN, H_NONCE, H_PATHNAME, H_SESSION } from './request';

export async function getShellSession() {
  return decodeSession((await headers()).get(H_SESSION));
}
export async function getAccessToken() {
  return (await headers()).get(H_ACCESS_TOKEN) ?? undefined;
}
export async function getRequestPathname() {
  return (await headers()).get(H_PATHNAME) ?? '/';
}
export async function getNonce() {
  return (await headers()).get(H_NONCE) ?? undefined;
}
