import type { MessageBundle } from './messagePacks';

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function makeT(messages: MessageBundle) {
  return function t(path: string, params?: Record<string, string | number>): string {
    const raw = getByPath(messages as unknown as Record<string, unknown>, path);
    if (typeof raw !== 'string') return path;
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, key: string) =>
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`,
    );
  };
}

export type TFunction = ReturnType<typeof makeT>;
