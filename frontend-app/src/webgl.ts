/**
 * WebGL capability probe.
 *
 * Cesium decides which context to request like this (Context.js):
 *
 *     const webgl2Supported = typeof WebGL2RenderingContext !== "undefined"
 *     const webgl2 = !requestWebgl1 && webgl2Supported
 *     canvas.getContext(webgl2 ? "webgl2" : "webgl", ...)
 *
 * It tests for the *constructor*, which every current browser defines, and
 * never falls back on its own — if `getContext("webgl2")` then returns null it
 * throws "The browser supports WebGL, but initialization failed." and the
 * globe never appears.
 *
 * Firefox returns null there whenever WebGL2 is switched off or the GPU driver
 * is on its blocklist ("AllowWebgl2:false restricts context creation on this
 * system"), while WebGL1 still works perfectly well. Chrome's blocklist is
 * narrower, which is why the same machine renders fine there.
 *
 * So we probe for real, and tell Cesium what it can actually have.
 */

export type WebGLSupport = 'webgl2' | 'webgl1' | 'none'

function canCreate(kind: 'webgl2' | 'webgl'): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext(kind) as WebGLRenderingContext | null
    if (!gl) return false
    // Contexts are a limited resource (browsers cap them at ~16 per page) and
    // this one is only a probe, so hand it back straight away instead of
    // waiting for garbage collection.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    // Some hardened configurations throw rather than returning null.
    return false
  }
}

function detect(): WebGLSupport {
  if (canCreate('webgl2')) return 'webgl2'
  if (canCreate('webgl')) return 'webgl1'
  return 'none'
}

/** Probed once at startup; the answer cannot change during a page's life. */
export const webglSupport: WebGLSupport = detect()

/**
 * Passed to the Cesium Viewer as `contextOptions`. Undefined lets Cesium keep
 * its WebGL2 default; `requestWebgl1` is set only when WebGL2 is genuinely
 * unavailable, so machines that support it are unaffected.
 */
export const cesiumContextOptions =
  webglSupport === 'webgl1' ? { requestWebgl1: true } : undefined

if (webglSupport === 'webgl1') {
  console.info(
    'WebGL2 ist in diesem Browser nicht verfügbar — Cesium läuft im WebGL1-Modus. ' +
      'In Firefox lässt sich WebGL2 unter about:config mit webgl.enable-webgl2=true ' +
      'aktivieren, sofern der Grafiktreiber es zulässt.',
  )
}
