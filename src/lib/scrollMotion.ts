/**
 * The motion of one eased scroll: from where the view is (moving or not)
 * to where a normal scroll would put it, in a fixed time.
 *
 * The path is a quintic — the "minimum-jerk" curve. Starting and ending at
 * rest its speed is a bell curve, 30·(s²)(1−s)²·D/T, whose area is exactly
 * the scroll distance D: the view travels precisely as far as a normal
 * scroll, starting gently, fastest in the middle, and settling into place
 * with zero speed and zero acceleration. (A true Gaussian never quite
 * reaches its end; this one does, exactly at T.)
 *
 * When another wheel event arrives mid-motion, the path is planned again
 * from the current position, speed and acceleration, so the motion stays
 * continuous.
 */

export interface Motion {
  from: number;
  to: number;
  /** Milliseconds. */
  duration: number;
  /** Polynomial coefficients in t (ms): p(t) = Σ c[i]·tⁱ. */
  coefficients: [number, number, number, number, number, number];
}

/** A quintic from (p0, v0, a0) to (p1, at rest) over `duration` ms. */
function quintic(p0: number, v0: number, a0: number, p1: number, duration: number): Motion {
  const T = duration;
  const D = p1 - p0;
  return {
    from: p0,
    to: p1,
    duration: T,
    coefficients: [
      p0,
      v0,
      a0 / 2,
      (20 * D - 12 * v0 * T - 3 * a0 * T * T) / (2 * T ** 3),
      (-30 * D + 16 * v0 * T + 3 * a0 * T * T) / (2 * T ** 4),
      (12 * D - 6 * v0 * T - a0 * T * T) / (2 * T ** 5),
    ],
  };
}

export function positionAt(motion: Motion, time: number): number {
  if (time >= motion.duration) return motion.to;
  const c = motion.coefficients;
  const t = Math.max(0, time);
  return c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
}

export function velocityAt(motion: Motion, time: number): number {
  if (time >= motion.duration) return 0;
  const c = motion.coefficients;
  const t = Math.max(0, time);
  return c[1] + t * (2 * c[2] + t * (3 * c[3] + t * (4 * c[4] + t * 5 * c[5])));
}

export function accelerationAt(motion: Motion, time: number): number {
  if (time >= motion.duration) return 0;
  const c = motion.coefficients;
  const t = Math.max(0, time);
  return 2 * c[2] + t * (6 * c[3] + t * (12 * c[4] + t * 20 * c[5]));
}

/** Whether the path stays between its ends (no overshoot past the
 *  target and back). */
function monotonic(motion: Motion): boolean {
  const low = Math.min(motion.from, motion.to) - 0.5;
  const high = Math.max(motion.from, motion.to) + 0.5;
  for (let step = 1; step < 24; step++) {
    const p = positionAt(motion, (motion.duration * step) / 24);
    if (p < low || p > high) return false;
  }
  return true;
}

/**
 * Plan a motion to `to`, continuing smoothly from the current state.
 * Arriving fast at a short distance would overshoot and swing back;
 * then the motion takes longer (up to 4×) so it glides in instead.
 */
export function planMotion(from: number, velocity: number, acceleration: number, to: number, duration: number): Motion {
  let motion = quintic(from, velocity, acceleration, to, duration);
  for (let attempt = 0; attempt < 6 && !monotonic(motion); attempt++) {
    duration *= 1.3;
    motion = quintic(from, velocity, acceleration, to, duration);
  }
  if (!monotonic(motion)) motion = quintic(from, 0, 0, to, duration);
  return motion;
}

/** Where a scroll ends: on a whole line, within the scrollable range. */
export function snapTarget(target: number, lineHeight: number, max: number): number {
  const snapped = lineHeight > 0 ? Math.round(target / lineHeight) * lineHeight : target;
  return Math.min(Math.max(0, snapped), Math.max(0, max));
}
