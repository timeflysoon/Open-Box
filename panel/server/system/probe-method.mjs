export const PROBE_METHODS = ['GET', 'HEAD', 'TCP', 'TLS']
export const normalizeProbeMethod = (value = 'GET') => {
  const method = String(value).toUpperCase()
  if (!PROBE_METHODS.includes(method)) throw new Error('method must be GET, HEAD, TCP or TLS')
  return method
}
