import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Pipette } from "lucide-react";
import { useColorPickerStore, type ColorPickerRequest } from "../../store/colorPickerStore";
import { formatsFor, hsvToRgb, isLight, parseColor, rgbToHsv, toHex, type Hsva, type Rgba } from "../../lib/colorPicker/colors";
import "./ColorPicker.css";

/**
 * The color picker the editor opens from the light bulb or a swatch:
 * pick by eye (or eyedropper, or by typing any CSS color), see the color
 * in the code as you go, Enter to keep it as hex — or insert or copy it in
 * any other format.
 */

const RECENT_KEY = "sable.recentColors";
const WIDTH = 300;

function recentColors(): string[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]).filter((color) => parseColor(color));
  } catch {
    return [];
  }
}

function remember(hex: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([hex, ...recentColors().filter((color) => color !== hex)].slice(0, 12)));
  } catch {
    // Storage unavailable: no recent colors.
  }
}

export function ColorPicker() {
  const request = useColorPickerStore((state) => state.request);
  if (!request) return null;
  // A new request (another slot) starts fresh.
  return <Picker key={`${request.x},${request.y}`} request={request} />;
}

function Picker({ request }: { request: ColorPickerRequest }) {
  const close = useColorPickerStore((state) => state.close);
  const start = useMemo<Rgba>(
    () => request.initial ?? parseColor(recentColors()[0] ?? "") ?? { r: 124, g: 147, b: 255, a: 1 },
    [request.initial],
  );
  const [hsv, setHsv] = useState<Hsva>(() => rgbToHsv(start));
  const color = useMemo(() => hsvToRgb(hsv), [hsv]);
  const hex = toHex(color);
  const [typed, setTyped] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: request.x, top: request.y + request.lineHeight + 4 });
  const panel = useRef<HTMLDivElement>(null);
  const finished = useRef(false);
  const touched = useRef(false);

  const formats = useMemo(() => formatsFor(color), [color]);
  const recent = useMemo(() => recentColors(), []);

  // The code shows the color as it's picked (not before the first change).
  useEffect(() => {
    if (touched.current) request.preview(hex);
  }, [hex, request]);

  const finish = (text: string | null) => {
    if (finished.current) return;
    finished.current = true;
    if (text === null) request.cancel();
    else {
      request.commit(text);
      remember(hex);
    }
    close();
  };

  // Keep it on screen: below the slot, or above it when there's no room.
  useLayoutEffect(() => {
    const box = panel.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(request.x, window.innerWidth - box.width - 8));
    const below = request.y + request.lineHeight + 4;
    const top = below + box.height > window.innerHeight - 8 ? Math.max(8, request.y - box.height - 4) : below;
    setPosition({ left, top });
    // Keys come here, not to the editor (typing would move the slot).
    panel.current?.focus();
  }, [request]);

  // Escape puts back what was there; clicking away keeps the color.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      } else if (event.key === "Enter" && !(event.target instanceof HTMLInputElement && event.target.dataset.colorText)) {
        event.preventDefault();
        event.stopPropagation();
        finish(touched.current || !request.initial ? hex : null);
      }
    };
    const onDown = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) finish(touched.current ? hex : null);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  });

  const change = (next: Hsva) => {
    touched.current = true;
    setTyped(null);
    setHsv(next);
  };
  const setColor = (rgba: Rgba) => change(rgbToHsv(rgba, hsv.h));

  /** Drag inside an element: `onMove` gets the pointer's 0–1 position. */
  const drag = (onMove: (x: number, y: number) => void) => (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const box = element.getBoundingClientRect();
    const move = (clientX: number, clientY: number) =>
      onMove(Math.min(1, Math.max(0, (clientX - box.left) / box.width)), Math.min(1, Math.max(0, (clientY - box.top) / box.height)));
    move(event.clientX, event.clientY);
    element.setPointerCapture(event.pointerId);
    const onPointerMove = (moved: PointerEvent) => move(moved.clientX, moved.clientY);
    const stop = () => {
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", stop);
    };
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", stop);
  };

  const eyeDropper = typeof window !== "undefined" && "EyeDropper" in window;
  const pickFromScreen = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await new (window as any).EyeDropper().open();
      const picked = parseColor(result.sRGBHex);
      if (picked) setColor(picked);
    } catch {
      // Cancelled.
    }
  };

  const copy = async (id: string, value: string) => {
    await navigator.clipboard.writeText(value).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied((current) => (current === id ? null : current)), 1200);
  };

  const hue = `hsl(${hsv.h} 100% 50%)`;
  const opaque = `rgb(${color.r} ${color.g} ${color.b})`;
  const swatches = [...new Set([...request.documentColors, ...recent])].slice(0, 20);

  return (
    <div
      ref={panel}
      className="color-picker"
      style={{ left: position.left, top: position.top, width: WIDTH }}
      role="dialog"
      aria-label="Color picker"
      tabIndex={-1}
    >
      <div className="color-picker-preview">
        {request.initial && (
          <button
            className="color-picker-original"
            title="Back to the original color"
            style={{ background: toHex(request.initial), color: isLight(request.initial) ? "#000" : "#fff" }}
            onClick={() => setColor(request.initial!)}
          >
            {toHex(request.initial)}
          </button>
        )}
        <div className="color-picker-current" style={{ background: hex, color: isLight(color) || color.a < 0.5 ? "#000" : "#fff" }}>
          {hex}
        </div>
      </div>

      <div
        className="color-picker-square"
        style={{ background: hue }}
        onPointerDown={drag((x, y) => change({ ...hsv, s: x, v: 1 - y }))}
      >
        <div className="color-picker-square-white" />
        <div className="color-picker-square-black" />
        <div className="color-picker-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: opaque }} />
      </div>

      <div className="color-picker-sliders">
        {eyeDropper && (
          <button className="color-picker-icon" title="Pick a color from the screen" onClick={() => void pickFromScreen()}>
            <Pipette size={14} strokeWidth={1.5} />
          </button>
        )}
        <div className="color-picker-tracks">
          <div className="color-picker-track hue" onPointerDown={drag((x) => change({ ...hsv, h: x * 360 }))}>
            <div className="color-picker-track-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: hue }} />
          </div>
          <div className="color-picker-track alpha" onPointerDown={drag((x) => change({ ...hsv, a: Math.round(x * 100) / 100 }))}>
            <div className="color-picker-track-fill" style={{ background: `linear-gradient(to right, transparent, ${opaque})` }} />
            <div className="color-picker-track-thumb" style={{ left: `${hsv.a * 100}%`, background: hex }} />
          </div>
        </div>
      </div>

      <div className="color-picker-text">
        <input
          data-color-text="1"
          spellCheck={false}
          value={typed ?? hex}
          aria-label="Color"
          onFocus={(event) => event.target.select()}
          onChange={(event) => {
            setTyped(event.target.value);
            const parsed = parseColor(event.target.value);
            if (parsed) {
              touched.current = true;
              setHsv(rgbToHsv(parsed, hsv.h));
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(hex);
            }
          }}
        />
        <button className="color-picker-insert" onClick={() => finish(hex)} title="Insert as hex (Enter)">
          Insert
        </button>
      </div>

      {swatches.length > 0 && (
        <div className="color-picker-swatches">
          {swatches.map((swatch) => (
            <button
              key={swatch}
              className="color-picker-swatch"
              style={{ background: swatch }}
              title={swatch}
              onClick={() => {
                const parsed = parseColor(swatch);
                if (parsed) setColor(parsed);
              }}
            />
          ))}
        </div>
      )}

      <div className="color-picker-formats">
        {formats.map((format) => (
          <div key={format.id} className="color-picker-format">
            <span className="color-picker-format-label">{format.label}</span>
            <button className="color-picker-format-value" title={`Insert ${format.value}`} onClick={() => finish(format.value)}>
              {format.value}
            </button>
            <button className="color-picker-icon small" title="Copy" onClick={() => void copy(format.id, format.value)}>
              {copied === format.id ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.5} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
