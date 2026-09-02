function isDaytonaPreviewOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return hostname.endsWith(".daytonaproxy01.net")
  } catch {
    return false
  }
}

export function isPreviewEdgeManagedCorsOrigin(origin: string, devMode: boolean): boolean {
  // Daytona's preview edge adds the complete CORS response itself. Running
  // Hono's CORS middleware too produces comma-joined duplicate origin and
  // credential headers that browsers reject.
  return devMode && isDaytonaPreviewOrigin(origin)
}
