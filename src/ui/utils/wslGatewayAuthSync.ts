export const WSL_AUTH_STORAGE_KEY = 'ao:wsl-gateway-authorized'
export const WSL_AUTH_EVENT = 'ao:wsl-gateway-authorized-changed'

export function readWslGatewayAuthorizedFromStorage(): boolean {
  try {
    return localStorage.getItem(WSL_AUTH_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function persistWslGatewayAuthorizedToStorage(authorized: boolean): void {
  try {
    localStorage.setItem(WSL_AUTH_STORAGE_KEY, authorized ? '1' : '0')
    window.dispatchEvent(new CustomEvent<boolean>(WSL_AUTH_EVENT, { detail: authorized }))
  } catch {
    // noop
  }
}

export function subscribeWslGatewayAuthorized(onChange: (authorized: boolean) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== WSL_AUTH_STORAGE_KEY) return
    onChange(event.newValue === '1')
  }
  const onCustom = (event: Event) => {
    const customEvent = event as CustomEvent<boolean>
    if (typeof customEvent.detail === 'boolean') onChange(customEvent.detail)
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(WSL_AUTH_EVENT, onCustom as EventListener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(WSL_AUTH_EVENT, onCustom as EventListener)
  }
}
