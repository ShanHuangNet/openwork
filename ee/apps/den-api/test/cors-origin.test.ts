import { describe, expect, test } from "bun:test"
import { isPreviewEdgeManagedCorsOrigin } from "../src/cors-origin.js"

describe("Den API CORS origin resolution", () => {
  const previewOrigin = "https://3005-example.daytonaproxy01.net"

  test("leaves Daytona development preview headers to the preview edge", () => {
    expect(isPreviewEdgeManagedCorsOrigin(previewOrigin, true)).toBe(true)
  })

  test("keeps production and non-preview origins under app CORS", () => {
    expect(isPreviewEdgeManagedCorsOrigin(previewOrigin, false)).toBe(false)
    expect(isPreviewEdgeManagedCorsOrigin("https://app.example.com", true)).toBe(false)
  })

  test("does not delegate malformed origins", () => {
    expect(isPreviewEdgeManagedCorsOrigin("not a URL", true)).toBe(false)
  })
})
