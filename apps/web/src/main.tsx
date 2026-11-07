import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { shouldRetryQuery } from './lib/http'
import './lib/theme'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 401/403 不重试：否则会重复弹二次验证框或重复踢回登录
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
