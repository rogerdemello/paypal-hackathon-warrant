import { createContext, useContext, type ReactNode } from 'react';
import type { PublicConfigDto } from '@warrant/server/api-types';
import { api } from './api';
import { useLoad } from './hooks';
import { ErrorNote, Spinner } from './components/ui';

const ConfigContext = createContext<PublicConfigDto | null>(null);

/** Loads the deployment's public configuration once and makes it available to every page. */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const config = useLoad(() => api.config(), []);
  if (config.data === null) {
    return (
      <div className="page narrow">
        {config.error === null ? <Spinner label="Connecting to the server" /> : <ErrorNote error={config.error} onRetry={config.reload} />}
      </div>
    );
  }
  return <ConfigContext.Provider value={config.data}>{children}</ConfigContext.Provider>;
}

export function useConfig(): PublicConfigDto {
  const value = useContext(ConfigContext);
  if (value === null) throw new Error('useConfig must be used inside ConfigProvider');
  return value;
}
