/**
 * UUID v4 — portável entre Electron main (Node) e React Native (Hermes).
 * Usa crypto.randomUUID() quando disponível e cai para uma implementação
 * pura em JS quando não está (ex.: Hermes sem crypto polyfill).
 */
export function newUuid(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
