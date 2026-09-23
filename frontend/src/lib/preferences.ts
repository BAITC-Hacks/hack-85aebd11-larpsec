import { useState } from 'react';

export function storedChoice<T extends string>(key: string, choices: readonly T[]): T | null {
  try {
    const value = localStorage.getItem(key);
    return choices.includes(value as T) ? value as T : null;
  } catch { return null; }
}
export function saveChoice(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Storage can be disabled. */ }
}
export function useStoredChoice<T extends string>(key: string, choices: readonly T[], fallback: T): [T, (value: T) => void] {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: storedChoice(key, choices) ?? fallback }));
  const value = state.key === key ? state.value : storedChoice(key, choices) ?? fallback;
  return [value, (next) => { saveChoice(key, next); setState({ key, value: next }); }];
}
