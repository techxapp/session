// jsdom has no <canvas>; Excalidraw touches a 2D context at import time and for text measurement.
const ctx2d = new Proxy(
  { filter: "none", font: "20px sans-serif", measureText: (t: string) => ({ width: t.length * 11 }) } as Record<string, unknown>,
  { get: (target, key) => (key in target ? target[key as string] : () => undefined) },
);
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement["getContext"];

// ...nor the CSS Font Loading API.
class FakeFontFace {
  constructor(
    public family: string,
    public source: string,
    public descriptors?: Record<string, string>,
  ) {}
  load() {
    return Promise.resolve(this);
  }
}
Object.assign(globalThis, { FontFace: FakeFontFace });
if (!("fonts" in document)) {
  Object.defineProperty(document, "fonts", {
    value: { add() {}, check: () => true, load: () => Promise.resolve([]), ready: Promise.resolve() },
  });
}
