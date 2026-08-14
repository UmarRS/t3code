import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

/**
 * This build ships no hosted web app, so there is never a hosted pairing URL to
 * hand out. Callers fall back to the endpoint's own `/pair` URL.
 */
export function resolveHostedPairingUrl(_endpointUrl: string, _credential: string): string | null {
  return null;
}
