/**
 * Two small gaps between Node and the browser.
 *
 * `enrich/spotify.ts` base64-encodes its client credentials with `Buffer`, which browsers have
 * not got. Rather than fork the provider, give it the one method it calls. Imported for its side
 * effect before anything that might construct a provider client.
 */
interface BufferLike {
  from(input: string): { toString(encoding: "base64"): string };
}

const shim: BufferLike = {
  from: (input: string) => ({ toString: () => btoa(input) }),
};

// `@types/node` reaches this build through the backend's type-only imports, so `Buffer` is
// already declared as the full Node constructor; cast past it to install the one method used.
const target = globalThis as unknown as { Buffer?: BufferLike };
target.Buffer ??= shim;
