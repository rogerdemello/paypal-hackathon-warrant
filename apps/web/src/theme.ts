import { useCallback, useEffect, useState } from 'react';
import { readStored, writeStored } from './storage';

/** Light is the default; dark is a per-browser choice. The inline script in index.html applies it before the first paint. */

export type Theme = 'light' | 'dark';
const KEY = 'warrant.theme';

export const storedTheme = (): Theme => (readStored(KEY) === 'dark' ? 'dark' : 'light');

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      writeStored(KEY, next === 'dark' ? 'dark' : null);
      return next;
    });
  }, []);
  return [theme, toggle];
}
