import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { healthResponseSchema, type HealthResponse } from '@firstwrite/shared';
import React from 'react';

const defaultQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health', {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }
  const json: unknown = await response.json();
  return healthResponseSchema.parse(json);
}

export function MorningPagesShell() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
  });

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="max-w-xl w-full space-y-4 text-center">
        <h1 className="text-3xl font-serif tracking-tight text-stone-900">Morning Pages</h1>
        <p className="text-stone-600 text-base">
          Write one free-form entry per day. Private, encrypted, distraction-free.
        </p>
        <div
          className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-4 py-1.5 text-xs text-stone-600 shadow-sm"
          role="status"
          aria-live="polite"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              data?.status === 'ok' ? 'bg-emerald-500' : isError ? 'bg-amber-500' : 'bg-stone-300'
            }`}
          />
          <span>
            {isLoading
              ? 'Checking API status…'
              : data?.status === 'ok'
                ? 'API connected'
                : 'API offline'}
          </span>
        </div>
      </div>
    </main>
  );
}

export function App({ queryClient = defaultQueryClient }: { queryClient?: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MorningPagesShell />
    </QueryClientProvider>
  );
}

export default App;
