// Monaco internals Sable reuses so its behavior matches Monaco's exactly.
declare module "monaco-editor/esm/vs/base/browser/mouseEvent.js" {
  /** A wheel event normalized the way Monaco's scrollbars read it:
   *  deltas in "notches" (positive = up / left). */
  export class StandardWheelEvent {
    constructor(event: WheelEvent);
    readonly deltaX: number;
    readonly deltaY: number;
  }
}
